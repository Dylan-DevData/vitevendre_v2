import { digestHex } from './sha256.js';
import { AndroidContentFile } from './native-video-source.js';

// Le fichier source a disparu (supprimé, déplacé, droits retirés) ou a changé.
export class SourceGoneError extends Error {
  constructor(message = 'Le fichier vidéo est introuvable : il a été supprimé ou déplacé.') {
    super(message);
    this.name = 'SourceGoneError';
  }
}

const GONE_NAMES = new Set(['NotFoundError', 'NotReadableError', 'SecurityError']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBlob(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

// Lecture "zéro RAM" : on ne lit JAMAIS le fichier entier, seulement la tranche
// demandée (512 Ko à 2 Mo) via file.slice(), directement depuis le stockage du téléphone.
export class FileSource {
  constructor(file) {
    this.file = file;
    this.size = file.size;
    this.name = file.name || 'video';
    this.type = file.type || 'video/mp4';
  }

  async read(start, end) {
    // Vérifie que la taille de la source n'a pas changé depuis sa sélection.
    // Le fichier a changé de taille (supprimé, remplacé, tronqué) depuis la sélection.
    if (this.file.size !== this.size) throw new SourceGoneError();
    let lastError;
    // Quelques WebView Android refusent une lecture isolée ("too many calls") : un court
    // délai suffit le plus souvent. Si l'échec persiste, le fichier est considéré perdu.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // slice() lit seulement la plage demandée : le fichier complet ne passe pas en mémoire.
        const buffer = await readBlob(this.file.slice(start, end));
        if (buffer.byteLength !== end - start) throw new SourceGoneError('Lecture incomplète du fichier.');
        return new Uint8Array(buffer);
      } catch (error) {
        if (error instanceof SourceGoneError) throw error;
        lastError = error;
        if (!GONE_NAMES.has(error && error.name) && attempt >= 1) break;
        await sleep(150 * (attempt + 1));
      }
    }
    throw new SourceGoneError(
      `Le fichier vidéo n’est plus lisible (${(lastError && lastError.name) || 'erreur'}). ` +
      'Il a peut-être été supprimé ou déplacé.'
    );
  }
}

export function openSource(file) {
  // Le sélecteur SAF Android fournit une URI content://; le pont natif lit des plages bornées depuis cette URI.
  if (file instanceof AndroidContentFile) return file;
  return new FileSource(file);
}

export const FINGERPRINT_SCHEME = 'content-chain-v1';
const SIGNATURE_BLOCK_BYTES = 512 * 1024;

// Hache chaque octet par blocs bornés de 512 Kio. Android effectue ce calcul dans le pont natif,
// ce qui évite des centaines d'allers-retours Cordova et de conversions Base64; les autres
// plateformes lisent les blocs avec File.slice().
export async function computeFingerprint(source) {
  if (source instanceof AndroidContentFile) return source.computeFingerprint();
  const size = source.size;
  const encoder = new TextEncoder();
  let chain = await digestHex(encoder.encode(`vitevendre-upload-v1:${size}`));
  for (let start = 0; start < size; start += SIGNATURE_BLOCK_BYTES) {
    const end = Math.min(start + SIGNATURE_BLOCK_BYTES, size);
    const block = await source.read(start, end);
    const blockHash = await digestHex(block);
    chain = await digestHex(encoder.encode(`${chain}:${blockHash}`));
  }
  return chain;
}
