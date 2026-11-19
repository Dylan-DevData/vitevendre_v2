import { AndroidContentFile, restoreAndroidVideo, NativeSourceError } from './native-video-source.js';
import { SourceGoneError, computeFingerprint } from './source.js';

export async function checkFilePermission(source) {
  if (source instanceof AndroidContentFile) return source.checkFilePermission();
  return true;
}

export async function checkFileExists(source) {
  try { await source.read(0, Math.min(1, source.size)); return true; }
  catch (error) {
    if (error instanceof SourceGoneError || (error instanceof NativeSourceError && error.code === 'SOURCE_MISSING')) return false;
    throw error;
  }
}

export async function checkFileReadable(source) {
  if (!(await checkFileExists(source))) throw new SourceGoneError();
  return true;
}

export async function getFileMetadata(source) {
  if (source instanceof AndroidContentFile) return source.getFileMetadata();
  return { name: source.name, mimeType: source.type, size: source.size, lastModified: source.file?.lastModified || null };
}

export async function compareFileIdentity(source, expectedFingerprint) {
  if (!expectedFingerprint) return false;
  return (await computeFingerprint(source)) === expectedFingerprint;
}

export async function reopenFile(metadata) {
  if (metadata?.uri?.startsWith('content://')) return restoreAndroidVideo(metadata);
  throw new SourceGoneError('Sélectionne à nouveau ce fichier pour reprendre l’envoi.');
}

// Donne au UploadTask une seule plage non modifiée. Le client ne crée pas les fichiers
// .part : il envoie cette plage, et le backend la stocke/référence pour FFmpeg.
export function readFileChunk(source, start, end) { return source.read(start, end); }

// Android ouvre puis ferme le ParcelFileDescriptor dans chaque appel readRange. Aucun descripteur
// natif ne reste donc ouvert ici. Cette fonction conserve une interface commune pour de futures sources.
export async function releaseFileHandle(source) {
  if (typeof source?.releaseFileHandle === 'function') await source.releaseFileHandle();
}
