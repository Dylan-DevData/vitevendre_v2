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

// Lecture par plages : le fichier entier ne passe jamais en mémoire. Une seule tranche
// est lue à la fois; ses octets restent temporairement en mémoire avant le PATCH réseau.
export class FileSource {
  constructor(file) {
    this.file = file;
    this.size = file.size;
    this.name = file.name || 'video';
    this.type = file.type || 'video/mp4';
  }

  async read(start, end) {
    // Renvoie exactement une plage du fichier original. Cette plage peut couper
    // n'importe où dans le conteneur MP4 : le client ne crée pas les .part serveur
    // et ne tente pas de décoder les morceaux; il envoie les octets sans les modifier.
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
export const SESSION_KEY_SCHEME = 'session-key-v2';
const SIGNATURE_BLOCK_BYTES = 512 * 1024;

// Crée une clé aléatoire propre à la tâche. Elle sert à rendre POST /api/uploads
// reprenable sans lire et hacher toute la vidéo avant de commencer le transfert.
// La reprise réelle s'appuie sur l'uploadId et, sur Android, sur l'URI/droits/métadonnées.
export function createSessionKey() {
  const bytes = new Uint8Array(32);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Repli pour les WebView anciens; cette valeur identifie une tâche, elle ne protège aucun secret.
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Compatibilité avec les anciennes tâches qui ont enregistré une empreinte du contenu.
// Les nouvelles tâches utilisent SESSION_KEY_SCHEME et évitent ce scan complet avant l'upload.
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
