import { ApiError } from '../api-core.js';
import { ChunkSizer, MAX_CHUNK, ANDROID_MAX_CHUNK } from './chunk-sizer.js';
import { FINGERPRINT_SCHEME, SourceGoneError, computeFingerprint, openSource } from './source.js';
import { NativeSourceError } from './native-video-source.js';
import { checkFilePermission, checkFileReadable, readFileChunk, compareFileIdentity } from './file-verification.js';

// États : idle, hashing, uploading, waiting-network, paused, processing, source-gone,
//         mismatch, error, cancelled.
// Événements (CustomEvent) : "state" (detail = snapshot) et "progress" (detail = snapshot).

const MAX_BACKOFF_MS = 8000;

function defaultEnv() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  let releaseOnlineWait = null;
  return {
    isOnline: () => !nav || nav.onLine !== false,
    waitOnline: () => new Promise((resolve) => {
      if (!nav || nav.onLine !== false) return resolve();
      const finish = () => {
        globalThis.removeEventListener('online', handler);
        releaseOnlineWait = null;
        resolve();
      };
      const handler = () => finish();
      releaseOnlineWait = finish;
      globalThis.addEventListener('online', handler);
    }),
    wakeOnline: () => { if (releaseOnlineWait) releaseOnlineWait(); },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

export class UploadTask extends EventTarget {
  constructor({ file, caption = '', api, env = defaultEnv(), expectedFingerprint = null, expectedFingerprintScheme = null, resumeUploadId = null,
    onFingerprint = async () => {}, onSession = async () => {}, onSessionInvalidated = async () => {} }) {
    super();
    this.file = file;
    this.caption = caption;
    this.api = api;
    this.env = env;
    this.expectedFingerprint = expectedFingerprint;
    this.expectedFingerprintScheme = expectedFingerprintScheme;
    // Le pont SAF Android renvoie le morceau en Base64 : sa limite est de 1 Mio; le navigateur peut aller à 2 Mio.
    this.sizer = new ChunkSizer({ max: file && file.kind === 'android-content' ? ANDROID_MAX_CHUNK : MAX_CHUNK });
    this.resumeUploadId = resumeUploadId;
    this.onFingerprint = onFingerprint;
    this.onSession = onSession;
    this.onSessionInvalidated = onSessionInvalidated;
    this.state = 'idle';
    this.error = null;
    this.uploadId = null;
    this.videoId = null;
    this.fingerprint = null;
    this.sent = 0;
    this.total = file.size;
    this.paused = false;
    this.cancelled = false;
    this.controller = null;
    this.wakeUp = null;
  }

  snapshot() {
    const speed = this.sizer.speed;
    const remaining = this.total - this.sent;
    return {
      state: this.state,
      uploadId: this.uploadId,
      videoId: this.videoId,
      fingerprint: this.fingerprint,
      sent: this.sent,
      total: this.total,
      speed,
      eta: speed > 0 ? Math.ceil(remaining / speed) : null,
      chunkSize: this.sizer.next(),
      error: this.error,
    };
  }

  #setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.dispatchEvent(new CustomEvent('state', { detail: this.snapshot() }));
  }

  #progress() {
    this.dispatchEvent(new CustomEvent('progress', { detail: this.snapshot() }));
  }

  pause() {
    if (['uploading', 'waiting-network'].includes(this.state)) {
      this.paused = true;
      if (this.controller) this.controller.abort();
      this.#setState('paused');
    }
  }

  resume() {
    if (this.paused) {
      this.paused = false;
      if (this.wakeUp) this.wakeUp();
    }
  }

  async cancel() {
    this.cancelled = true;
    this.paused = false;
    if (this.controller) this.controller.abort();
    if (this.wakeUp) this.wakeUp();
    if (this.env.wakeOnline) this.env.wakeOnline();
    if (this.uploadId) await this.api.abortUpload(this.uploadId);
    this.#setState('cancelled');
  }

  // Lance l'envoi. Résout avec { videoId } quand le serveur a reçu tout le fichier.
  async start() {
    const source = openSource(this.file);
    try {
      this.#setState('hashing');
      await checkFilePermission(source);
      await checkFileReadable(source);
      // Cette empreinte aide le backend à retrouver l'envoi après une interruption.
      this.fingerprint = await computeFingerprint(source);
      if (this.expectedFingerprintScheme === FINGERPRINT_SCHEME && this.expectedFingerprint && this.expectedFingerprint !== this.fingerprint) {
        const error = new Error('Ce fichier n’est pas celui de l’envoi interrompu.');
        this.#setState('mismatch', error.message);
        throw error;
      }
      await this.onFingerprint(this.fingerprint);

      // Après un redémarrage Android, privilégie l'identifiant persisté ; sinon le POST déduplique
      // une session active par empreinte (utile également au navigateur après nouvelle sélection).
      let session = null;
      if (this.resumeUploadId) {
        try {
          session = await this.#retry(() => this.api.getUpload(this.resumeUploadId));
          if (session.totalSize !== source.size) throw new Error('La taille de la vidéo ne correspond plus à la session en attente.');
          if (session.status === 'complete') {
            this.uploadId = session.uploadId;
            this.videoId = session.videoId;
            this.sent = source.size;
            await this.onSession(session);
            this.#setState('processing');
            return { videoId: this.videoId, alreadyComplete: true };
          }
          if (session.status !== 'in_progress') throw new Error('La session d’envoi n’est plus active.');
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          session = null; // session expirée côté serveur : le POST en créera une nouvelle.
        }
      }
      if (!session) {
        // Ce POST ne transporte que les métadonnées ; les octets vidéo partent ensuite par PATCH.
        session = await this.#retry(() => this.api.createUpload({
          mime_type: source.type || 'video/mp4',
          total_size: source.size,
          fingerprint: this.fingerprint,
          caption: this.caption,
        }));
      }
      if (this.cancelled) return null;
      this.uploadId = session.uploadId;
      this.videoId = session.videoId;
      this.sent = session.receivedBytes;
      if (Number.isFinite(Number(session.maxChunkBytes))) this.sizer.setMax(Number(session.maxChunkBytes));
      await this.onSession(session);
      this.dispatchEvent(new CustomEvent('session', { detail: this.snapshot() }));

      await this.#transfer(source);
      if (this.cancelled) return null;

      // La source peut changer pendant la lecture des morceaux. Recalculer son empreinte avant
      // la finalisation détecte ce changement; seul un bloc borné est conservé en mémoire.
      this.#setState('hashing');
      await checkFilePermission(source);
      if (!(await compareFileIdentity(source, this.fingerprint))) {
        const message = 'Cette vidéo a été modifiée pendant l’envoi. Sélectionne le fichier original pour reprendre.';
        // Ne jamais réutiliser une session qui pourrait mélanger des morceaux de deux versions du fichier.
        if (this.uploadId) {
          try {
            await this.#retry(() => this.api.abortUpload(this.uploadId));
          } catch (abortError) {
            if (!(abortError instanceof ApiError && abortError.status === 404)) throw abortError;
          }
          this.uploadId = null;
          await this.onSessionInvalidated();
        }
        this.#setState('mismatch', message);
        throw new Error(message);
      }

      const done = await this.#complete();
      this.videoId = done.videoId || this.videoId;
      this.#setState('processing');
      return { videoId: this.videoId };
    } catch (error) {
      if (this.cancelled) return null;
      if (error instanceof SourceGoneError || (error instanceof NativeSourceError && error.code === 'SOURCE_MISSING')) {
        // Une source supprimée ou devenue illisible arrête cette tâche; la file tente ensuite
        // d'annuler la session serveur sans bloquer les autres vidéos.
        this.#setState('source-gone', error.message);
      } else if (error instanceof NativeSourceError && error.code === 'SOURCE_MOVED') {
        this.#setState('source-moved', error.message);
      } else if (error instanceof NativeSourceError && error.code === 'SOURCE_CHANGED') {
        this.#setState('mismatch', error.message);
      } else if (error instanceof NativeSourceError) {
        this.#setState('source-unavailable', error.message);
      } else if (!['mismatch'].includes(this.state)) {
        this.#setState('error', error.message || 'Envoi impossible.');
      }
      throw error;
    }
  }

  async #waitIfPaused() {
    while (this.paused && !this.cancelled) {
      await new Promise((resolve) => { this.wakeUp = resolve; });
      this.wakeUp = null;
    }
  }

  async #waitOnline() {
    if (this.env.isOnline()) return;
    this.#setState('waiting-network');
    await this.env.waitOnline();
  }

  // Réessaie les erreurs réseau/serveur avec un délai croissant ; s'arrête sur une vraie erreur 4xx.
  async #retry(operation) {
    let attempt = 0;
    for (;;) {
      await this.#waitIfPaused();
      await this.#waitOnline();
      if (this.cancelled) throw new Error('Envoi annulé.');
      try {
        return await operation();
      } catch (error) {
        const retryable = error instanceof ApiError
          && (error.network || error.status === 408 || error.status === 429 || error.status >= 500);
        if (!retryable) throw error;
        attempt += 1;
        await this.env.sleep(Math.min(MAX_BACKOFF_MS, 400 * 2 ** attempt));
      }
    }
  }

  async #transfer(source) {
    this.#setState('uploading');
    let failures = 0;
    while (this.sent < this.total) {
      await this.#waitIfPaused();
      if (this.cancelled) return;
      await this.#waitOnline();
      if (this.state !== 'uploading') this.#setState('uploading');

      const start = this.sent;
      const end = Math.min(start + this.sizer.next(), this.total);
      // L'offset confirmé par le serveur marque le début de la prochaine tranche à lire.
      // Lecture d'une seule tranche : une erreur ici = fichier perdu, pas un problème réseau.
      const bytes = await readFileChunk(source, start, end);

      this.controller = new AbortController();
      const requestController = this.controller;
      const abortOffline = () => requestController.abort();
      globalThis.addEventListener?.('offline', abortOffline, { once: true });
      const timeout = setTimeout(() => requestController.abort(), Math.max(20000, (bytes.length / 8192) * 1000));
      const t0 = this.env.now();
      try {
        // Le corps de cette requête contient uniquement `bytes`, jamais le fichier complet.
        const result = await this.api.patchChunk(this.uploadId, start, bytes, requestController.signal);
        if (result.status === 409 && result.data && Number.isFinite(result.data.receivedBytes)) {
          // Le serveur est la source de vérité : on se recale sur son offset.
          this.sent = result.data.receivedBytes;
          this.#progress();
          continue;
        }
        if (result.status === 200) {
          this.sent = result.data.receivedBytes;
          failures = 0;
          this.sizer.onSuccess(bytes.length, Math.max(1, this.env.now() - t0));
          this.#progress();
          continue;
        }
        if (result.status === 408 || result.status === 409 || result.status === 429 || result.status >= 500) {
          throw new ApiError({ status: result.status, code: 'RETRY' });
        }
        throw new ApiError({
          status: result.status,
          message: (result.data && result.data.error) || `Morceau refusé (${result.status}).`,
        });
      } catch (error) {
        if (this.cancelled) return;
        const aborted = error && error.name === 'AbortError';
        if (aborted && this.paused) continue; // pause demandée par l'utilisateur
        const retryable = aborted
          || (error instanceof ApiError && (error.network || error.code === 'RETRY'));
        if (!retryable) throw error;
        // Coupure : taille de morceau minimale, puis on demande au serveur où reprendre.
        this.sizer.onFailure();
        failures += 1;
        this.#progress();
        await this.env.sleep(Math.min(MAX_BACKOFF_MS, 400 * 2 ** failures));
        await this.#resync();
      } finally {
        clearTimeout(timeout);
        globalThis.removeEventListener?.('offline', abortOffline);
        this.controller = null;
      }
    }
  }

  // Reprise : on interroge le serveur et on repart exactement à receivedBytes.
  async #resync() {
    // Ne pas envoyer d'autre PATCH avant que le serveur ait confirmé l'offset actuel.
    const status = await this.#retry(() => this.api.getUpload(this.uploadId));
    if (!['in_progress', 'complete'].includes(status.status)) throw new Error('Cette session d’envoi n’est plus active.');
    this.sent = status.receivedBytes;
  }

  async #complete() {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // Le backend valide le fichier assemblé sur disque, puis l'envoie à la file FFmpeg.
        return await this.#retry(() => this.api.completeUpload(this.uploadId));
      } catch (error) {
        // Octets manquants (rare) : on se recale puis on renvoie la fin.
        if (error instanceof ApiError && error.status === 409 && attempt < 3) {
          await this.#resync();
          const source = openSource(this.file);
          await this.#transfer(source);
          if (!(await compareFileIdentity(source, this.fingerprint))) {
            const message = 'Cette vidéo a été modifiée pendant l’envoi. Sélectionne le fichier original pour reprendre.';
            try { await this.#retry(() => this.api.abortUpload(this.uploadId)); }
            catch (abortError) { if (!(abortError instanceof ApiError && abortError.status === 404)) throw abortError; }
            this.uploadId = null;
            await this.onSessionInvalidated();
            this.#setState('mismatch', message);
            throw new Error(message);
          }
          continue;
        }
        throw error;
      }
    }
  }
}
