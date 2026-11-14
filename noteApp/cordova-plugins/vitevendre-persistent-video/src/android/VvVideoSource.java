package com.vitevendre.videosource;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
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
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.List;

/** Android SAF bridge: persists a content URI and reads only requested byte ranges. */
public final class VvVideoSource extends CordovaPlugin {
    private static final int PICK_REQUEST = 7314;
    private static final int MAX_RANGE_BYTES = 1024 * 1024;
    private static final String PREFS = "vitevendre_upload_resume";
    private static final String PENDING = "pending_metadata";

    private CallbackContext pickerCallback;
    private final Object prefsLock = new Object();

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callback) throws JSONException {
        switch (action) {
            case "pick":
                pick(callback);
                return true;
            case "readRange":
                readRange(args, callback);
                return true;
            case "loadPending":
                loadPending(callback);
                return true;
            case "savePending":
                savePending(args, callback);
                return true;
            case "finishUpload":
                finishUpload(args, callback);
                return true;
            case "abandon":
                abandon(callback);
                return true;
            case "releaseUri":
                releaseUri(args, callback);
                return true;
            default:
                return false;
        }
    }

    /** Open Android's system document picker and request a persistable read grant. */
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
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            callback.error(error("PICKER_CANCELLED", "Sélection de vidéo annulée."));
            return;
        }

        Uri uri = data.getData();
        int grantFlags = data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION;
        if (grantFlags == 0) grantFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION;
        try {
            cordova.getActivity().getContentResolver().takePersistableUriPermission(uri, grantFlags);
        } catch (SecurityException | IllegalArgumentException ex) {
            callback.error(error("PERSIST_PERMISSION_FAILED",
                "Android ou ce fournisseur ne permet pas de conserver l'accès. Choisis la vidéo avec l'application Fichiers du téléphone.", ex));
            return;
        }

        final CallbackContext resultCallback = callback;
        cordova.getThreadPool().execute(() -> {
            try {
                JSONObject metadata = queryMetadata(uri);
                probeSeekable(uri, metadata.getLong("size"));
                resultCallback.success(metadata);
            } catch (PluginFailure ex) {
                release(uri);
                resultCallback.error(error(ex.code, ex.getMessage(), ex));
            } catch (Exception ex) {
                release(uri);
                resultCallback.error(error("PROVIDER_ERROR",
                    "Impossible de lire cette vidéo. Essaie de la choisir avec l'application Fichiers.", ex));
            }
        });
    }

    /** Read display name, MIME type and known size without reading video content. */
    private JSONObject queryMetadata(Uri uri) throws Exception {
        ContentResolver resolver = cordova.getActivity().getContentResolver();
        String name = null;
        long size = -1;
        try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
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
        value.put("mimeType", mime);
        value.put("size", size);
        value.put("fingerprint", "");
        value.put("uploadId", "");
        value.put("videoId", JSONObject.NULL);
        value.put("caption", "");
        value.put("status", "selected");
        return value;
    }

    /** Probe both ends so unsupported pipe-style providers fail before the upload begins. */
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

    /** Return one bounded range as Base64; never return the whole video to JavaScript. */
    private void readRange(JSONArray args, CallbackContext callback) throws JSONException {
        String uriText = args.getString(0);
        long start = args.getLong(1);
        int length = args.getInt(2);
        JSONObject pending = readStoredPending();
        if (pending == null || !uriText.equals(pending.optString("uri"))) {
            callback.error(error("URI_REVOKED", "L'accès à cette vidéo n'est plus conservé. Choisis-la à nouveau."));
            return;
        }
        long size = pending.optLong("size", -1);
        if (start < 0 || length < 1 || length > MAX_RANGE_BYTES || start + length > size) {
            callback.error(error("INVALID_RANGE", "La plage demandée est invalide."));
            return;
        }
        if (!hasReadGrant(Uri.parse(uriText))) {
            callback.error(error("URI_REVOKED", "Android a révoqué l'accès à cette vidéo. Choisis-la à nouveau."));
            return;
        }

        cordova.getThreadPool().execute(() -> {
            try (ParcelFileDescriptor descriptor = cordova.getActivity().getContentResolver()
                    .openFileDescriptor(Uri.parse(uriText), "r");
                 FileInputStream input = new FileInputStream(descriptor.getFileDescriptor())) {
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
                String message = "Impossible de relire cette plage. Le fichier a peut-être été déplacé ou l'accès a été révoqué.";
                callback.error(error("SOURCE_UNAVAILABLE", message, ex));
            }
        });
    }

    private void loadPending(CallbackContext callback) {
        // Cordova's JSONObject callback should always receive JSON; represent no pending item as {}.
        JSONObject pending = readStoredPending();
        callback.success(pending == null ? new JSONObject() : pending);
    }

    /** Save an allowlist of small metadata fields only; file bytes are never accepted here. */
    private void savePending(JSONArray args, CallbackContext callback) throws JSONException {
        JSONObject input = args.getJSONObject(0);
        JSONObject clean = new JSONObject();
        String[] allowed = {"uri", "name", "mimeType", "size", "fingerprint", "uploadId", "videoId", "caption", "status"};
        for (String key : allowed) if (input.has(key)) clean.put(key, input.get(key));
        String uri = clean.optString("uri", "");
        if (!uri.isEmpty() && !uri.startsWith("content://")) {
            callback.error(error("INVALID_URI", "Android n'accepte ici que l'URI content:// du sélecteur système."));
            return;
        }
        writeStoredPending(clean);
        callback.success(clean);
    }

    /** Once upload bytes are safely accepted by the server, release the document grant. */
    private void finishUpload(JSONArray args, CallbackContext callback) throws JSONException {
        JSONObject previous = readStoredPending();
        if (previous != null) release(Uri.parse(previous.optString("uri", "")));
        JSONObject processing = new JSONObject();
        processing.put("videoId", args.isNull(0) ? JSONObject.NULL : args.get(0));
        processing.put("status", "processing");
        writeStoredPending(processing);
        callback.success(processing);
    }

    /** Explicit abandon releases the persisted Android read permission and forgets metadata. */
    private void abandon(CallbackContext callback) {
        JSONObject pending = readStoredPending();
        if (pending != null) release(Uri.parse(pending.optString("uri", "")));
        synchronized (prefsLock) {
            prefs().edit().remove(PENDING).apply();
        }
        callback.success();
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
            // Grant déjà révoqué : il n'y a rien d'autre à libérer.
        }
    }

    private SharedPreferences prefs() {
        return cordova.getActivity().getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    private JSONObject readStoredPending() {
        synchronized (prefsLock) {
            String raw = prefs().getString(PENDING, null);
            if (raw == null) return null;
            try { return new JSONObject(raw); } catch (JSONException ignored) { return null; }
        }
    }

    private void writeStoredPending(JSONObject value) {
        synchronized (prefsLock) {
            prefs().edit().putString(PENDING, value.toString()).apply();
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
