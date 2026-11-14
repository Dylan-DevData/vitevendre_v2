/** Cordova bridge used only on Android; the browser keeps using its File object. */
export function isNativeAndroid() {
  return Boolean(window.cordova && window.cordova.platformId === 'android');
}

function bridge() {
  const value = window.cordova && window.cordova.plugins && window.cordova.plugins.vvVideoSource;
  if (!value) throw new NativeSourceError('PLUGIN_MISSING', 'Le sélecteur vidéo Android n’est pas installé. Reconstruis l’application.');
  return value;
}

export class NativeSourceError extends Error {
  constructor(code, message) {
    super(message || 'La vidéo Android n’est plus accessible.');
    this.name = 'NativeSourceError';
    this.code = code || 'SOURCE_UNAVAILABLE';
  }
}

function call(method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      bridge()[method](...args, resolve, (failure) => {
        const value = typeof failure === 'string' ? { message: failure } : (failure || {});
        reject(new NativeSourceError(value.code, value.message || value.error));
      });
    } catch (error) {
      reject(error instanceof NativeSourceError ? error : new NativeSourceError('PLUGIN_ERROR', error.message));
    }
  });
}

export class AndroidContentFile {
  constructor(metadata) {
    this.kind = 'android-content';
    this.uri = metadata.uri;
    this.name = metadata.name || 'video';
    this.type = metadata.mimeType || 'video/mp4';
    this.size = Number(metadata.size);
    this.fingerprint = metadata.fingerprint || '';
    if (!this.uri || !this.uri.startsWith('content://') || !Number.isSafeInteger(this.size) || this.size < 1) {
      throw new NativeSourceError('INVALID_METADATA', 'Android n’a pas fourni une URI et une taille de fichier valides.');
    }
  }

  async read(start, end) {
    if (start < 0 || end <= start || end > this.size || end - start > 1024 * 1024) {
      throw new NativeSourceError('INVALID_RANGE', 'La plage de lecture Android est invalide ou trop grande.');
    }
    const result = await call('readRange', this.uri, start, end - start);
    let binary;
    try { binary = atob(result.base64); } catch (error) {
      throw new NativeSourceError('INVALID_RANGE_DATA', 'Android a renvoyé une plage vidéo illisible.');
    }
    if (binary.length !== end - start) {
      throw new NativeSourceError('SOURCE_CHANGED', 'La vidéo a changé ou le fournisseur a renvoyé une plage incomplète.');
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

export async function pickAndroidVideo() {
  const metadata = await call('pick');
  return new AndroidContentFile(metadata);
}

export const restoreAndroidVideo = (metadata) => new AndroidContentFile(metadata);
export const loadAndroidPending = async () => {
  const metadata = await call('loadPending');
  return metadata && metadata.uri ? metadata : null;
};
export const saveAndroidPending = (metadata) => call('savePending', metadata);
export const finishAndroidUpload = (videoId) => call('finishUpload', videoId);
export const abandonAndroidUpload = () => call('abandon');
export const releaseAndroidUri = (uri) => call('releaseUri', uri);
