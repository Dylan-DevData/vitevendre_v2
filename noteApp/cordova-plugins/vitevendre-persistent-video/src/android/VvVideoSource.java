package com.vitevendre.videosource;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.util.List;

/** Pont Android SAF : conserve l'accès URI accordé et lit uniquement les plages demandées. */
public final class VvVideoSource extends CordovaPlugin {
    private static final int PICK_REQUEST = 7314;
    private static final int MAX_RANGE_BYTES = 1024 * 1024;
    private CallbackContext pickerCallback;

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callback) throws JSONException {
        switch (action) {
            case "pick":
                pick(callback);
                return true;
            case "readRange":
                readRange(args, callback);
                return true;
            case "verify":
                verify(args, callback);
                return true;
            case "fingerprint":
                fingerprint(args, callback);
                return true;
            case "releaseUri":
                releaseUri(args, callback);
                return true;
            default:
                return false;
        }
    }

    /** Ouvre le sélecteur Android et demande une autorisation de lecture persistante. */
    private void pick(CallbackContext callback) {
        if (pickerCallback != null) {
            callback.error(error("PICKER_BUSY", "Le sélecteur de fichiers est déjà ouvert."));
            return;
        }
        pickerCallback = callback;
        cordova.getActivity().runOnUiThread(() -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("video/*");
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            try {
                cordova.startActivityForResult(this, intent, PICK_REQUEST);
            } catch (Exception ex) {
                finishPickerError("PICKER_FAILED", "Impossible d'ouvrir le sélecteur Android.", ex);
            }
        });
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_REQUEST || pickerCallback == null) return;
        CallbackContext callback = pickerCallback;
        pickerCallback = null;
        if (resultCode != Activity.RESULT_OK || data == null || (data.getData() == null && data.getClipData() == null)) {
            callback.error(error("PICKER_CANCELLED", "Selection cancelled."));
            return;
        }
        JSONArray selected = new JSONArray();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) selected.put(data.getClipData().getItemAt(i).getUri().toString());
        } else selected.put(data.getData().toString());
        int flags = data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION;
        if (flags == 0) flags = Intent.FLAG_GRANT_READ_URI_PERMISSION;
        final int grantFlags = flags;
        final CallbackContext resultCallback = callback;
        cordova.getThreadPool().execute(() -> {
            JSONArray metadataList = new JSONArray();
            try {
                for (int i = 0; i < selected.length(); i++) {
                    Uri uri = Uri.parse(selected.getString(i));
                    cordova.getActivity().getContentResolver().takePersistableUriPermission(uri, grantFlags);
                    JSONObject metadata = queryMetadata(uri);
                    probeSeekable(uri, metadata.getLong("size"));
                    boolean persisted = hasReadGrant(uri);
                    metadata.put("permissionPersisted", persisted);
                    if (!persisted) throw new IOException("Persisted URI permission not confirmed");
                    metadataList.put(metadata);
                }
                resultCallback.success(metadataList);
            } catch (Exception ex) {
                for (int i = 0; i < selected.length(); i++) {
                    try { release(Uri.parse(selected.getString(i))); } catch (JSONException ignored) { }
                }
                boolean permissionFailure = ex instanceof SecurityException || ex instanceof IllegalArgumentException;
                String code = permissionFailure ? "PERSIST_PERMISSION_FAILED" : "PICKER_FAILED";
                String message = permissionFailure
                    ? "Ce fournisseur Android ne permet pas de conserver l’autorisation. Choisis la vidéo avec l’application Fichiers ou sélectionne-la à nouveau à chaque reprise."
                    : "Impossible d’ouvrir ou de lire une des vidéos sélectionnées. Vérifie qu’elle est toujours disponible.";
                resultCallback.error(error(code, message, ex));
            }
        });
    }
    /** Récupère le nom, le type MIME et la taille sans lire le contenu vidéo. */
    private JSONObject queryMetadata(Uri uri) throws Exception {
        ContentResolver resolver = cordova.getActivity().getContentResolver();
        String name = null;
        String sourceLocation = null;
        long size = -1;
        long lastModified = -1;
        try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                int modifiedIndex = cursor.getColumnIndex(android.provider.DocumentsContract.Document.COLUMN_LAST_MODIFIED);
                int pathIndex = cursor.getColumnIndex(android.provider.MediaStore.MediaColumns.RELATIVE_PATH);
                if (nameIndex >= 0) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
                if (modifiedIndex >= 0 && !cursor.isNull(modifiedIndex)) lastModified = cursor.getLong(modifiedIndex);
                if (pathIndex >= 0 && !cursor.isNull(pathIndex)) sourceLocation = cursor.getString(pathIndex);
            }
        }
        if (size < 0) {
            try (android.content.res.AssetFileDescriptor afd = resolver.openAssetFileDescriptor(uri, "r")) {
                if (afd != null) size = afd.getLength();
            }
        }
        if (size <= 0) {
            throw new PluginFailure("RANGE_UNSUPPORTED",
                "Ce fournisseur ne donne pas la taille du fichier. Choisis-le avec l'application Fichiers du téléphone.");
        }
        String mime = resolver.getType(uri);
        if (mime == null || !mime.startsWith("video/")) mime = "video/mp4";
        JSONObject value = new JSONObject();
        value.put("uri", uri.toString());
        value.put("name", name == null ? "video" : name);
        value.put("sourceLocation", sourceLocation == null ? JSONObject.NULL : sourceLocation);
        value.put("mimeType", mime);
        value.put("size", size);
        value.put("lastModified", lastModified < 0 ? JSONObject.NULL : lastModified);
        value.put("fingerprint", "");
        value.put("uploadId", "");
        value.put("videoId", JSONObject.NULL);
        value.put("caption", "");
        value.put("status", "selected");
        return value;
    }

    /** Vérifie les deux extrémités afin de refuser avant l'envoi les fournisseurs non compatibles avec la lecture par plages. */
    private void probeSeekable(Uri uri, long size) throws Exception {
        try (ParcelFileDescriptor descriptor = cordova.getActivity().getContentResolver().openFileDescriptor(uri, "r")) {
            if (descriptor == null) throw new IOException("Pas de descripteur de fichier.");
            try (FileInputStream input = new FileInputStream(descriptor.getFileDescriptor())) {
                FileChannel channel = input.getChannel();
                channel.position(0);
                if (channel.read(ByteBuffer.allocate(1)) != 1) throw new IOException("Lecture du début impossible.");
                channel.position(size - 1);
                if (channel.read(ByteBuffer.allocate(1)) != 1) throw new IOException("Lecture de la fin impossible.");
            }
        } catch (Exception ex) {
            throw new PluginFailure("RANGE_UNSUPPORTED",
                "Ce fournisseur Android ne permet pas la lecture par plages. Essaie de choisir la vidéo dans Fichiers ou Téléchargements.", ex);
        }
    }

    /** Renvoie une plage bornée en Base64; ne transmet jamais toute la vidéo à JavaScript. */
    private void verify(JSONArray args, CallbackContext callback) throws JSONException {
        Uri uri = Uri.parse(args.getString(0));
        if (!hasReadGrant(uri)) {
            callback.error(error("URI_REVOKED", "Android a révoqué l’accès à cette vidéo. Sélectionne-la à nouveau."));
            return;
        }
        cordova.getThreadPool().execute(() -> {
            try {
                JSONObject metadata = queryMetadata(uri);
                try (ParcelFileDescriptor descriptor = cordova.getActivity().getContentResolver().openFileDescriptor(uri, "r");
                     FileInputStream input = new FileInputStream(descriptor.getFileDescriptor())) {
                    if (input.read() < 0) throw new IOException("Source is empty");
                }
                metadata.put("permissionPersisted", hasReadGrant(uri));
                callback.success(metadata);
            } catch (Exception ex) {
                String code = ex instanceof FileNotFoundException ? "SOURCE_MISSING" : "SOURCE_UNAVAILABLE";
                String message = "SOURCE_MISSING".equals(code)
                    ? "Cette vidéo n’est plus disponible sur votre téléphone. Elle a peut-être été supprimée. Sélectionne-la à nouveau."
                    : "ViteVendre n’a plus accès à cette vidéo. Sélectionne-la à nouveau pour autoriser l’accès.";
                callback.error(error(code, message, ex));
            }
        });
    }

    /** Hache la source complète en natif en ne gardant qu'un bloc de 512 Kio en mémoire. */
    private void fingerprint(JSONArray args, CallbackContext callback) throws JSONException {
        Uri uri = Uri.parse(args.getString(0));
        String expectedName = args.optString(1, "");
        long expectedSize = args.optLong(2, -1);
        long expectedModified = args.optLong(3, -1);
        String expectedLocation = args.length() > 4 && !args.isNull(4) ? args.optString(4, "") : "";
        if (!hasReadGrant(uri)) {
            callback.error(error("URI_REVOKED", "Android a révoqué l'accès à cette vidéo."));
            return;
        }
        cordova.getThreadPool().execute(() -> {
            try {
                JSONObject before = queryMetadata(uri);
                validateFingerprintSource(before, expectedName, expectedSize, expectedModified, expectedLocation);
                long size = before.getLong("size");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                String chain = hex(digest.digest(("vitevendre-upload-v1:" + size).getBytes(StandardCharsets.UTF_8)));
                byte[] block = new byte[512 * 1024];
                try (ParcelFileDescriptor descriptor = cordova.getActivity().getContentResolver().openFileDescriptor(uri, "r");
                     FileInputStream input = new FileInputStream(descriptor.getFileDescriptor())) {
                    FileChannel channel = input.getChannel();
                    long offset = 0;
                    while (offset < size) {
                        int length = (int) Math.min(block.length, size - offset);
                        ByteBuffer buffer = ByteBuffer.wrap(block, 0, length);
                        while (buffer.hasRemaining()) {
                            int count = channel.read(buffer);
                            if (count < 0) throw new PluginFailure("SOURCE_CHANGED", "La vidéo a changé pendant sa vérification.");
                        }
                        digest.reset();
                        digest.update(block, 0, length);
                        String blockHash = hex(digest.digest());
                        digest.reset();
                        chain = hex(digest.digest((chain + ":" + blockHash).getBytes(StandardCharsets.UTF_8)));
                        offset += length;
                    }
                }
                JSONObject after = queryMetadata(uri);
                validateFingerprintSource(after, expectedName, expectedSize, expectedModified, expectedLocation);
                callback.success(chain);
            } catch (PluginFailure ex) {
                callback.error(error(ex.code, ex.getMessage()));
            } catch (Exception ex) {
                String code = ex instanceof FileNotFoundException ? "SOURCE_MISSING" :
                    ex instanceof SecurityException ? "URI_REVOKED" : "SOURCE_UNAVAILABLE";
                callback.error(error(code, "La vidéo ne peut pas être vérifiée depuis son emplacement d'origine."));
            }
        });
    }

    private void validateFingerprintSource(JSONObject metadata, String name, long size, long modified, String location) throws Exception {
        if (size >= 0 && metadata.getLong("size") != size) {
            throw new PluginFailure("SOURCE_CHANGED", "La vidéo a été modifiée pendant sa vérification.");
        }
        if (!name.isEmpty() && !name.equals(metadata.optString("name", ""))) {
            throw new PluginFailure("SOURCE_CHANGED", "La vidéo a été renommée pendant sa vérification.");
        }
        long currentModified = metadata.isNull("lastModified") ? -1 : metadata.optLong("lastModified", -1);
        if (modified >= 0 && currentModified >= 0 && modified != currentModified) {
            throw new PluginFailure("SOURCE_CHANGED", "La vidéo a été modifiée pendant sa vérification.");
        }
        String currentLocation = metadata.isNull("sourceLocation") ? "" : metadata.optString("sourceLocation", "");
        if (!location.isEmpty() && !currentLocation.isEmpty() && !location.equals(currentLocation)) {
            throw new PluginFailure("SOURCE_MOVED", "La vidéo a été déplacée pendant sa vérification.");
        }
    }

    private static String hex(byte[] bytes) {
        final char[] digits = "0123456789abcdef".toCharArray();
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            int unsigned = value & 0xff;
            result.append(digits[unsigned >>> 4]).append(digits[unsigned & 0x0f]);
        }
        return result.toString();
    }

    /** Lit à l'offset demandé et renvoie une plage bornée; ne transmet jamais toute la vidéo à JavaScript. */
    private void readRange(JSONArray args, CallbackContext callback) throws JSONException {
        String uriText = args.getString(0);
        long start = args.getLong(1);
        int length = args.getInt(2);
        String expectedName = args.optString(3, "");
        long expectedSize = args.optLong(4, -1);
        long expectedModified = args.optLong(5, -1);
        String expectedLocation = args.length() > 6 && !args.isNull(6) ? args.optString(6, "") : "";
        if (start < 0 || length < 1 || length > MAX_RANGE_BYTES) {
            callback.error(error("INVALID_RANGE", "La plage demandée est invalide."));
            return;
        }
        if (!hasReadGrant(Uri.parse(uriText))) {
            callback.error(error("URI_REVOKED", "Android a révoqué l'accès à cette vidéo. Choisis-la à nouveau."));
            return;
        }

        cordova.getThreadPool().execute(() -> {
            try (ParcelFileDescriptor descriptor = cordova.getActivity().getContentResolver()
                    .openFileDescriptor(Uri.parse(uriText), "r")) {
                JSONObject metadata = queryMetadata(Uri.parse(uriText));
                String currentName = metadata.optString("name", "");
                long currentSize = metadata.optLong("size", -1);
                long currentModified = metadata.isNull("lastModified") ? -1 : metadata.optLong("lastModified", -1);
                String currentLocation = metadata.isNull("sourceLocation") ? "" : metadata.optString("sourceLocation", "");
                if ((expectedSize >= 0 && currentSize != expectedSize) || (!expectedName.isEmpty() && !expectedName.equals(currentName)) ||
                    (expectedModified >= 0 && currentModified >= 0 && expectedModified != currentModified)) {
                    callback.error(error("SOURCE_CHANGED", "La vidéo a été modifiée ou renommée pendant l'envoi."));
                    return;
                }
                if (!expectedLocation.isEmpty() && !currentLocation.isEmpty() && !expectedLocation.equals(currentLocation)) {
                    callback.error(error("SOURCE_MOVED", "La vidéo a été déplacée pendant l'envoi."));
                    return;
                }
                FileInputStream input = new FileInputStream(descriptor.getFileDescriptor());
                FileChannel channel = input.getChannel();
                channel.position(start);
                ByteBuffer buffer = ByteBuffer.allocate(length);
                while (buffer.hasRemaining()) {
                    int count = channel.read(buffer);
                    if (count < 0) break;
                }
                if (buffer.position() != length) {
                    callback.error(error("SOURCE_CHANGED", "Le fichier a été déplacé, modifié ou n'est plus entièrement lisible."));
                    return;
                }
                callback.success(new JSONObject()
                    .put("start", start)
                    .put("length", length)
                    .put("base64", Base64.encodeToString(buffer.array(), Base64.NO_WRAP)));
            } catch (Exception ex) {
                String code = ex instanceof FileNotFoundException ? "SOURCE_MISSING" : "SOURCE_UNAVAILABLE";
                String message = "SOURCE_MISSING".equals(code)
                    ? "Cette vidéo n’est plus disponible sur votre téléphone. Elle a peut-être été supprimée. Sélectionne-la à nouveau."
                    : "ViteVendre n’a plus accès à cette vidéo ou elle n’est plus lisible. Sélectionne-la à nouveau.";
                callback.error(error(code, message, ex));
            }
        });
    }

    private void releaseUri(JSONArray args, CallbackContext callback) throws JSONException {
        release(Uri.parse(args.getString(0)));
        callback.success();
    }

    private boolean hasReadGrant(Uri uri) {
        List<android.content.UriPermission> grants = cordova.getActivity().getContentResolver().getPersistedUriPermissions();
        for (android.content.UriPermission grant : grants) {
            if (grant.getUri().equals(uri) && grant.isReadPermission()) return true;
        }
        return false;
    }

    private void release(Uri uri) {
        if (uri == null || uri.toString().isEmpty()) return;
        try {
            cordova.getActivity().getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException | IllegalArgumentException ignored) {
            // Autorisation déjà révoquée : il n'y a plus rien à libérer.
        }
    }

    private JSONObject error(String code, String message) {
        JSONObject value = new JSONObject();
        try { value.put("code", code); value.put("message", message); } catch (JSONException ignored) { }
        return value;
    }

    private JSONObject error(String code, String message, Exception cause) {
        return error(code, message + (cause.getMessage() == null ? "" : " (" + cause.getMessage() + ")"));
    }

    private void finishPickerError(String code, String message, Exception cause) {
        CallbackContext callback = pickerCallback;
        pickerCallback = null;
        if (callback != null) callback.error(error(code, message, cause));
    }

    private static final class PluginFailure extends Exception {
        final String code;
        PluginFailure(String code, String message) { super(message); this.code = code; }
        PluginFailure(String code, String message, Throwable cause) { super(message, cause); this.code = code; }
    }
}
