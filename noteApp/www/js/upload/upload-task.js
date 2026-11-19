import { ApiError } from '../api-core.js';
import { ChunkSizer, MAX_CHUNK, ANDROID_MAX_CHUNK } from './chunk-sizer.js';
import { FINGERPRINT_SCHEME, SESSION_KEY_SCHEME, SourceGoneError, computeFingerprint, openSource } from './source.js';
import { NativeSourceError } from './native-video-source.js';
import { checkFilePermission, checkFileReadable, readFileChunk } from './file-verification.js';

// États : idle, checking-source, reading-chunk, uploading, waiting-network, paused, processing, source-gone,
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
    onFingerprint = async () => {}, onSession = async () => {} }) {
    super();
    this.file = file;
    this.caption = caption;
    this.api = api;
    this.env = env;
    this.expectedFingerprint = expectedFingerprint;
    this.expectedFingerprintScheme = expectedFingerprintScheme;
    // Android renvoie la plage en Base64; les deux clients restent plafonnés à 4 Mio par le serveur.
    this.sizer = new ChunkSizer({ max: file && file.kind === 'android-content' ? ANDROID_MAX_CHUNK : MAX_CHUNK });
    this.resumeUploadId = resumeUploadId;
    this.onFingerprint = onFingerprint;
    this.onSession = onSession;
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
    if (['reading-chunk', 'uploading', 'waiting-network'].includes(this.state)) {
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
      this.#setState('checking-source');
      await checkFilePermission(source);
      await checkFileReadable(source);
      // Les nouvelles tâches réutilisent leur clé aléatoire déjà sauvegardée dans IndexedDB.
      // Ainsi l'upload démarre sans parcourir une première fois tout le fichier. Les anciennes
      // tâches content-chain-v1 gardent leur vérification complète pour rester reprenables.
      const hasSessionKey = this.expectedFingerprintScheme === SESSION_KEY_SCHEME && this.expectedFingerprint;
      this.fingerprint = hasSessionKey ? this.expectedFingerprint : await computeFingerprint(source);
      if (!hasSessionKey && this.expectedFingerprintScheme === FINGERPRINT_SCHEME
        && this.expectedFingerprint && this.expectedFingerprint !== this.fingerprint) {
        const error = new Error('Ce fichier n’est pas celui de l’envoi interrompu.');
        this.#setState('mismatch', error.message);
        throw error;
      }
      await this.onFingerprint(this.fingerprint, hasSessionKey ? SESSION_KEY_SCHEME : FINGERPRINT_SCHEME);

      // Après un redémarrage Android, privilégie l'identifiant de session persisté. La clé stable
      // de tâche rend aussi un POST réessayé idempotent si sa première réponse a été perdue.
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

      // Vérifie les droits et métadonnées avant l'assemblage sans relire les octets déjà envoyés.
      // Android contrôle taille, date et emplacement à chaque lecture de plage; côté Web,
      // File est un objet Blob immuable et FileSource vérifie sa taille à chaque lecture.
      this.#setState('checking-source');
      await checkFilePermission(source);

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
    let failures = 0;
    while (this.sent < this.total) {
      await this.#waitIfPaused();
      if (this.cancelled) return;
      await this.#waitOnline();
      if (this.state !== 'uploading') this.#setState('uploading');

      const start = this.sent;
      const end = Math.min(start + this.sizer.next(), this.total);
      // La lecture Android passe par le pont Cordova et Base64; l'indiquer séparément
      // évite de faire croire que le réseau est bloqué avant même le premier PATCH.
      this.#setState('reading-chunk');
      // L'offset confirmé par le serveur marque le début de la prochaine tranche à lire.
      // Cette tranche est une plage d'octets arbitraire, pas un petit fichier vidéo autonome.
      // Le client la lit puis l'envoie; seul le serveur la nomme et la persiste en .part.
      // Une erreur de lecture ici signifie que la source locale est inaccessible, pas le réseau.
      const bytes = await readFileChunk(source, start, end);
      await this.#waitIfPaused();
      if (this.cancelled) return;
      await this.#waitOnline();
      this.#setState('uploading');

      this.controller = new AbortController();
      const requestController = this.controller;
      const abortOffline = () => requestController.abort();
      globalThis.addEventListener?.('offline', abortOffline, { once: true });
      const timeout = setTimeout(() => requestController.abort(), Math.max(20000, (bytes.length / 8192) * 1000));
      const t0 = this.env.now();
      try {
        // Le PATCH contient uniquement `bytes`. Le backend enregistre ce bloc confirmé
        // comme <uploadId>.<chunkNumber>.part et garde sa référence/son offset en base.
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
        // Quand tous les .part sont confirmés, le backend demande à FFmpeg de lire
        // leur flux dans l'ordre et de créer un MP4; la file traite ensuite ce MP4 en HLS.
        return await this.#retry(() => this.api.completeUpload(this.uploadId));
      } catch (error) {
        // Octets manquants (rare) : on se recale puis on renvoie la fin.
        if (error instanceof ApiError && error.status === 409 && attempt < 3) {
          await this.#resync();
          const source = openSource(this.file);
          await this.#transfer(source);
          await checkFilePermission(source);
          continue;
        }
        throw error;
      }
    }
  }
}
