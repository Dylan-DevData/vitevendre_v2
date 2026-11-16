import { UploadTask } from './upload-task.js';
import { uploadStorage } from './storage.js';
import { isNativeAndroid, releaseAndroidUri } from './native-video-source.js';
import { reopenFile } from './file-verification.js';
import { FINGERPRINT_SCHEME } from './source.js';

const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const FINAL_FILE_STATES = new Set(['missing_file', 'inaccessible_file', 'moved_file', 'mismatch']);
const isNotFound = (error) => error?.status === 404;

/** File persistante de métadonnées; les références File d'exécution restent en mémoire. */
export class UploadQueue extends EventTarget {
  constructor({ api, concurrency = 2 } = {}) {
    super();
    this.api = api;
    this.concurrency = Math.max(1, Number(concurrency) || 2);
    this.jobs = new Map();
    this.active = new Set();
    this.order = [];
    this.ready = this.restore();
  }

  emit() { this.dispatchEvent(new CustomEvent('change', { detail: this.snapshot() })); }
  snapshot() { return this.order.map((id) => this.jobs.get(id)).filter(Boolean).map((job) => ({
    id: job.meta.id, name: job.meta.name, size: job.meta.size,
    sent: FINAL_FILE_STATES.has(job.state) ? null : (job.task?.sent ?? job.meta.uploadedBytes ?? 0),
    total: FINAL_FILE_STATES.has(job.state) ? null : job.meta.size, speed: job.task?.sizer.speed || 0, state: job.state || job.meta.status,
    error: job.error || job.meta.lastError || null,
  })); }

  async restore() {
    const records = (await uploadStorage.all()).sort((a, b) =>
      (a.queueOrder ?? a.createdAt) - (b.queueOrder ?? b.createdAt));
    for (const meta of records) {
      if (meta.status === 'completed' || meta.status === 'cancelled') continue;
      const priorCancelNotFound = meta.status === 'error' &&
        String(meta.lastError || '').toLowerCase().includes('annulation serveur non confirm') &&
        String(meta.lastError || '').toLowerCase().includes('session d');
      if (priorCancelNotFound) {
        // Les anciennes versions conservaient une ligne en erreur après un DELETE 404.
        // La session étant déjà absente, cette ligne correspond à une annulation terminée.
        if (meta.uri) releaseAndroidUri(meta.uri).catch(() => {});
        await uploadStorage.remove(meta.id);
        continue;
      }
      const signature = meta.uri ? `uri:${meta.uri}` : `file:${meta.name}:${meta.size}:${meta.lastModified || 0}`;
      const job = { meta, file: null, task: null, state: meta.status, signature, error: meta.lastError || null };
      this.jobs.set(meta.id, job); this.order.push(meta.id);
      if (FINAL_FILE_STATES.has(meta.status)) continue;
      if (meta.status === 'processing' && meta.videoId) continue;
      if (meta.uri && isNativeAndroid()) {
        try { job.file = await reopenFile(meta); job.state = 'queued'; }
        catch (error) { job.state = 'inaccessible_file'; job.error = error.message; }
      } else if (!meta.uri) {
        job.state = 'inaccessible_file';
        job.error = 'La référence du fichier original est absente. Sélectionnez une autre vidéo pour publier.';
      }
      else job.state = 'inaccessible_file';
      await this.save(job);
    }
    this.emit(); this.pump();
  }

  async save(job) {
    job.meta.status = job.state;
    job.meta.lastError = job.error || null;
    await uploadStorage.put(job.meta);
    this.emit();
  }

  async add(file, caption = '') {
    const signature = file.kind === 'android-content' ? `uri:${file.uri}` : `file:${file.name}:${file.size}:${file.lastModified || 0}`;
    const duplicate = [...this.jobs.values()].find((j) => j.signature === signature ||
      (j.meta.uri && file.uri && j.meta.uri === file.uri) ||
      (!file.uri && j.file === file));
    if (duplicate) return duplicate.meta.id;
    const meta = {
      id: uid(), name: file.name || 'video', uri: file.uri || '', uriType: file.uri ? 'content' : 'file',
      sourceLocation: file.sourceLocation || null,
      mimeType: file.type || file.mimeType || 'video/mp4', size: Number(file.size), lastModified: file.lastModified || null,
      fingerprint: file.fingerprint || '', fingerprintScheme: '', uploadSessionId: '', uploadedBytes: 0, status: 'queued', retryCount: 0,
      permissionPersisted: Boolean(file.permissionPersisted), caption, videoId: null, queueOrder: this.order.length,
    };
    const job = { meta, file, task: null, state: 'queued', signature, error: null };
    this.jobs.set(meta.id, job); this.order.push(meta.id);
    await this.save(job); this.pump(); return meta.id;
  }

  async reassociate(id, file) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Tâche d’envoi introuvable.');
    job.file = file; job.meta.uri = file.uri || ''; job.meta.uriType = file.uri ? 'content' : 'file';
    job.meta.name = file.name; job.meta.size = file.size; job.meta.mimeType = file.type || 'video/mp4';
    job.meta.lastModified = file.lastModified ?? null;
    job.meta.sourceLocation = file.sourceLocation || null;
    job.meta.permissionPersisted = Boolean(file.permissionPersisted);
    job.state = 'queued'; job.error = null;
    await this.save(job); this.pump();
  }

  async pause(id) {
    const j = this.jobs.get(id); if (!j) return;
    if (j.task) j.task.pause();
    else if (j.state === 'queued') { j.state = 'paused'; await this.save(j); }
  }
  async resume(id) {
    const j = this.jobs.get(id); if (!j) return;
    if (FINAL_FILE_STATES.has(j.state)) return;
    if (j.task?.state === 'paused') { j.task.resume(); return; }
    if (j.file) { j.state = 'queued'; j.error = null; await this.save(j); this.pump(); }
  }
  async cancel(id) {
    const j = this.jobs.get(id); if (!j) return;
    try {
      if (j.task) await j.task.cancel();
      else if (j.meta.uploadSessionId) await this.api.abortUpload(j.meta.uploadSessionId);
    } catch (error) {
      if (!isNotFound(error)) {
        j.task = null; j.state = 'error'; j.error = `Annulation serveur non confirmée : ${error.message}`;
        this.active.delete(id); await this.save(j); this.pump(); throw error;
      }
    }
    if (j.meta.uri) await releaseAndroidUri(j.meta.uri).catch(() => {});
    await uploadStorage.remove(id);
    this.jobs.delete(id); this.order = this.order.filter((x) => x !== id); this.active.delete(id); this.emit(); this.pump();
  }

  async removeTerminal(id) {
    const job = this.jobs.get(id);
    if (!job || !FINAL_FILE_STATES.has(job.state)) return;
    // Le retrait local d'une tâche définitive n'attend jamais le nettoyage côté serveur.
    this.cleanupSession(job);
    if (job.meta.uri) releaseAndroidUri(job.meta.uri).catch(() => {});
    this.active.delete(id);
    this.jobs.delete(id);
    this.order = this.order.filter((jobId) => jobId !== id);
    await uploadStorage.remove(id).catch((error) => console.warn('Impossible de retirer les metadonnees locales.', error));
    this.emit();
    this.pump();
  }

  async move(id, delta) {
    const from = this.order.indexOf(id); const to = Math.max(0, Math.min(this.order.length - 1, from + delta));
    if (from < 0 || from === to) return;
    this.order.splice(from, 1); this.order.splice(to, 0, id);
    await Promise.all(this.order.map((taskId, index) => {
      const job = this.jobs.get(taskId); job.meta.queueOrder = index; return uploadStorage.put(job.meta);
    }));
    this.emit(); this.pump();
  }

  async complete(videoId) {
    const j = [...this.jobs.values()].find((job) => Number(job.meta.videoId) === Number(videoId));
    if (!j) return;
    if (j.meta.uri) await releaseAndroidUri(j.meta.uri).catch(() => {});
    j.state = 'completed'; await uploadStorage.remove(j.meta.id);
    this.jobs.delete(j.meta.id); this.order = this.order.filter((id) => id !== j.meta.id); this.emit();
  }

  cleanupSession(job) {
    if (!job.meta.uploadSessionId) return;
    this.api.abortUpload(job.meta.uploadSessionId).catch((error) => {
      if (!isNotFound(error)) console.warn('Le GC serveur nettoiera la session d’upload abandonnée.', error);
    });
  }

  pump() {
    while (this.active.size < this.concurrency) {
      const job = this.order.map((id) => this.jobs.get(id)).find((j) => j && j.state === 'queued' && j.file && !this.active.has(j.meta.id));
      if (!job) break;
      this.run(job);
    }
  }

  run(job) {
    const id = job.meta.id;
    this.active.add(id); job.state = 'hashing'; job.error = null;
    const task = new UploadTask({ file: job.file, caption: job.meta.caption || '', api: this.api,
      expectedFingerprint: job.meta.fingerprintScheme === FINGERPRINT_SCHEME ? job.meta.fingerprint : null,
      expectedFingerprintScheme: job.meta.fingerprintScheme || null,
      resumeUploadId: job.meta.uploadSessionId || null,
      onFingerprint: async (fingerprint) => {
        job.meta.fingerprint = fingerprint; job.meta.fingerprintScheme = FINGERPRINT_SCHEME;
        await uploadStorage.put(job.meta);
      },
      onSession: async (session) => {
        job.meta.uploadSessionId = session.uploadId; job.meta.videoId = session.videoId;
        job.meta.uploadedBytes = session.receivedBytes; await uploadStorage.put(job.meta);
      },
      onSessionInvalidated: async () => {
        job.meta.uploadSessionId = ''; job.meta.videoId = null; job.meta.uploadedBytes = 0;
        await uploadStorage.put(job.meta);
      },
    });
    job.task = task;
    task.addEventListener('state', async (e) => {
      job.state = e.detail.state; job.error = e.detail.error || null;
      if (e.detail.state === 'processing') {
        job.meta.videoId = e.detail.videoId; job.meta.uploadedBytes = job.meta.size;
        await this.save(job); this.active.delete(id); job.file = null; job.task = null; this.pump();
      } else if (['source-gone', 'source-unavailable', 'source-moved', 'mismatch'].includes(e.detail.state)) {
        job.state = e.detail.state === 'source-gone' ? 'missing_file' : e.detail.state === 'source-moved' ? 'moved_file' : e.detail.state === 'mismatch' ? 'mismatch' : 'inaccessible_file';
        job.error = e.detail.error || job.error;
        this.active.delete(id); job.task = null; job.file = null;
        await this.save(job); this.cleanupSession(job); this.pump();
      } else { await this.save(job); }
    });
    task.addEventListener('progress', async (e) => {
      job.meta.uploadedBytes = e.detail.sent; job.state = e.detail.state;
      await uploadStorage.put(job.meta); this.emit();
    });
    this.save(job).then(() => task.start()).then((result) => {
      if (result?.videoId) { job.meta.videoId = result.videoId; job.state = 'processing'; }
    }).catch(async (error) => {
      if (!FINAL_FILE_STATES.has(job.state)) {
        job.error = error.message;
        job.state = task.state === 'source-gone' ? 'missing_file' : task.state === 'source-moved' ? 'moved_file'
          : task.state === 'source-unavailable' ? 'inaccessible_file' : task.state === 'mismatch' ? 'mismatch' : 'error';
        this.active.delete(id); job.task = null;
        if (FINAL_FILE_STATES.has(job.state)) { job.file = null; await this.save(job); this.cleanupSession(job); }
        else await this.save(job);
        this.pump();
      }
    });
  }
}
