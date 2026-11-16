/** Pont Cordova utilisé sur Android; dans le navigateur, la source reste un objet File. */
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
    this.sourceLocation = metadata.sourceLocation || null;
    this.type = metadata.mimeType || 'video/mp4';
    this.size = Number(metadata.size);
    this.lastModified = metadata.lastModified == null ? null : Number(metadata.lastModified);
    this.fingerprint = metadata.fingerprint || '';
    this.permissionPersisted = metadata.permissionPersisted === true;
    if (!this.uri || !this.uri.startsWith('content://') || !Number.isSafeInteger(this.size) || this.size < 1) {
      throw new NativeSourceError('INVALID_METADATA', 'Android n’a pas fourni une URI et une taille de fichier valides.');
    }
  }

  async read(start, end) {
    if (start < 0 || end <= start || end > this.size || end - start > 1024 * 1024) {
      throw new NativeSourceError('INVALID_RANGE', 'La plage de lecture Android est invalide ou trop grande.');
    }
    const result = await call('readRange', this.uri, start, end - start, this.name, this.size,
      this.lastModified == null ? -1 : this.lastModified, this.sourceLocation || '');
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

  async checkFilePermission() {
    const current = await this.getFileMetadata();
    if (!current.permissionPersisted) {
      throw new NativeSourceError('URI_REVOKED', 'ViteVendre n’a plus accès à cette vidéo. Veuillez la sélectionner à nouveau pour autoriser son accès.');
    }
    if (Number(current.size) !== this.size || (this.name && current.name && current.name !== this.name) ||
      (this.lastModified != null && current.lastModified != null && Number(current.lastModified) !== this.lastModified)) {
      throw new NativeSourceError('SOURCE_CHANGED', 'Cette vidéo a été modifiée ou renommée depuis le début de l’envoi. Vérifiez le fichier avant de reprendre.');
    }
    if (this.sourceLocation && current.sourceLocation && current.sourceLocation !== this.sourceLocation) {
      throw new NativeSourceError('SOURCE_MOVED', 'Cette vidéo a été déplacée. Veuillez la sélectionner à nouveau pour confirmer l’accès et reprendre son envoi.');
    }
    return current;
  }

  async getFileMetadata() { return call('verify', this.uri); }

  async computeFingerprint() {
    return call('fingerprint', this.uri, this.name, this.size,
      this.lastModified == null ? -1 : this.lastModified, this.sourceLocation || '');
  }
}

export async function pickAndroidVideos() {
  const metadata = await call('pick');
  return (Array.isArray(metadata) ? metadata : [metadata]).map((item) => new AndroidContentFile(item));
}
export async function pickAndroidVideo() {
  return (await pickAndroidVideos())[0] || null;
}

export const restoreAndroidVideo = (metadata) => new AndroidContentFile(metadata);
export const verifyAndroidUri = (uri) => call('verify', uri);
export const releaseAndroidUri = (uri) => call('releaseUri', uri);
