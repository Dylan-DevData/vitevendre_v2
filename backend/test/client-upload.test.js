// Teste le vrai code client (noteApp/www/js/upload) contre le vrai serveur :
// réseau instable, hors-ligne, fichier supprimé en pause, reprise avec fichier renommé.
// Lancer :  E2E_DATABASE_URL=postgresql://... node --test --test-concurrency=1
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

const DB = process.env.E2E_DATABASE_URL;
const skip = !DB && 'E2E_DATABASE_URL non défini';
const client = (file) => import(pathToFileURL(path.join(__dirname, '..', '..', 'noteApp', 'www', 'js', file)).href);

test('sha256 JS pur = crypto natif', async () => {
  const { sha256Hex } = await client('upload/sha256.js');
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1000, 70000]) {
    const bytes = crypto.randomBytes(size);
    assert.equal(sha256Hex(bytes), crypto.createHash('sha256').update(bytes).digest('hex'), `taille ${size}`);
  }
});

test('ChunkSizer : monte doucement, retombe à 512 Ko après un échec', async () => {
  const { ChunkSizer, MIN_CHUNK, MAX_CHUNK } = await client('upload/chunk-sizer.js');
  const sizer = new ChunkSizer();
  assert.equal(sizer.next(), MIN_CHUNK);
  for (let i = 0; i < 20; i += 1) sizer.onSuccess(sizer.next(), 300); // réseau rapide
  assert.equal(sizer.next(), MAX_CHUNK);
  sizer.onFailure();
  assert.equal(sizer.next(), MIN_CHUNK);
  const slow = new ChunkSizer();
  for (let i = 0; i < 10; i += 1) slow.onSuccess(slow.next(), 8000); // ~64 Ko/s
  assert.equal(slow.next(), MIN_CHUNK);
});

test('UploadTask : coupures, hors-ligne, fichier supprimé puis reprise', { skip, timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vv2-client-'));
  process.env.DATABASE_URL = DB;
  process.env.JWT_SECRET = 'y'.repeat(40);
  process.env.UPLOAD_DIR = path.join(root, 'uploads');
  process.env.MEDIA_DIR = path.join(root, 'media');
  const { pool } = require('../src/config/db');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  const app = require('../src/app');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(async () => { server.close(); await pool.end(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const { createApi } = await client('api-core.js');
  const { UploadTask } = await client('upload/upload-task.js');
  const { FINGERPRINT_SCHEME } = await client('upload/source.js');

  // Vidéo de ~6 Mo : plusieurs morceaux de 512 Ko à 2 Mo.
  const src = path.join(root, 'in.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=25:d=4',
    '-c:v', 'libx264', '-b:v', '12M', '-pix_fmt', 'yuv420p', src]);
  const bytes = fs.readFileSync(src);
  assert.ok(bytes.length > 3 * 1024 * 1024, `vidéo de test trop petite : ${bytes.length}`);

  const reg = await (await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '677000111', fullName: 'Client Test', password: 'motdepasse123' }),
  })).json();

  // Réseau capricieux : le 2e et le 4e PATCH sont coupés après avoir envoyé la moitié du corps.
  let patches = 0;
  const flakyFetch = async (url, init) => {
    if (init && init.method === 'PATCH') {
      patches += 1;
      if (patches === 2 || patches === 4) {
        await fetch(url, { ...init, body: init.body.subarray(0, init.body.length >> 1),
          headers: { ...init.headers, 'Content-Length': String(init.body.length) } }).catch(() => {});
        throw new TypeError('fetch failed');
      }
    }
    return fetch(url, init);
  };
  const api = createApi({ base, getToken: () => reg.token, fetchImpl: flakyFetch });

  // Hors-ligne simulé pendant un moment.
  let online = true;
  const waiters = [];
  const env = {
    isOnline: () => online,
    waitOnline: () => new Promise((resolve) => waiters.push(resolve)),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    now: () => Date.now(),
  };
  const goOffline = () => { online = false; };
  const goOnline = () => { online = true; waiters.splice(0).forEach((fn) => fn()); };

  // --- Envoi 1 : le fichier "disparaît" après quelques lectures. ---
  let reads = 0;
  const readsBeforeUpload = Math.ceil(bytes.length / (512 * 1024)) + 1; // vérification initiale + empreinte
  const vanishing = {
    name: 'ma-video.mp4', type: 'video/mp4', size: bytes.length,
    slice(start, end) {
      reads += 1;
      if (reads > readsBeforeUpload + 3) return { arrayBuffer: async () => { throw Object.assign(new Error('gone'), { name: 'NotFoundError' }); } };
      return new Blob([bytes]).slice(start, end);
    },
  };
  const task1 = new UploadTask({ file: vanishing, caption: 'essai', api, env });
  const states = [];
  task1.addEventListener('state', (e) => states.push(e.detail.state));
  // Passe hors-ligne brièvement pendant l'envoi.
  task1.addEventListener('progress', () => {
    if (patches === 3 && online) { goOffline(); setTimeout(goOnline, 50); }
  });
  await assert.rejects(task1.start(), /introuvable|plus lisible/);
  assert.equal(task1.state, 'source-gone');
  assert.ok(states.includes('uploading'));
  assert.ok(task1.sent > 0 && task1.sent < bytes.length, `envoi partiel attendu, reçu ${task1.sent}`);
  const firstSession = task1.uploadId;

  // Le serveur a gardé la session et l'offset validé (jamais d'octets partiels en trop).
  const status = await api.getUpload(firstSession);
  assert.equal(status.status, 'in_progress');
  assert.equal(status.receivedBytes, task1.sent);
  const saved = await pool.query(
    `SELECT video_id, chunk_number, byte_offset, chunk_size, data
     FROM upload_chunks WHERE upload_id = $1 ORDER BY chunk_number`,
    [firstSession]
  );
  let savedOffset = 0;
  saved.rows.forEach((chunk, index) => {
    assert.equal(Number(chunk.video_id), task1.videoId);
    assert.equal(Number(chunk.chunk_number), index);
    assert.equal(Number(chunk.byte_offset), savedOffset);
    assert.equal(Number(chunk.chunk_size), chunk.data.length);
    savedOffset += chunk.data.length;
  });
  assert.equal(savedOffset, status.receivedBytes);
  assert.ok(Buffer.concat(saved.rows.map((chunk) => chunk.data)).equals(bytes.subarray(0, status.receivedBytes)));

  // --- Envoi 2 : même fichier RENOMMÉ -> même session, reprise sans renvoyer l'existant. ---
  const renamed = new File([bytes], 'autre-nom.mp4', { type: 'video/mp4' });
  const task2 = new UploadTask({ file: renamed, caption: 'essai', api, env, expectedFingerprint: task1.fingerprint });
  const sentFromServer = status.receivedBytes;
  const sessionEvent = new Promise((resolve) => task2.addEventListener('session', (e) => resolve(e.detail)));
  const result = await task2.start();
  const session2 = await sessionEvent;
  assert.equal(session2.uploadId, firstSession, 'la même session doit être reprise');
  assert.equal(session2.sent, sentFromServer, 'reprise exactement à l’offset du serveur');
  assert.ok(result.videoId > 0);
  assert.equal(task2.state, 'processing');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM upload_chunks WHERE upload_id = $1', [firstSession])).rows[0].n, 0);

  // --- Mauvais fichier : l'empreinte détecte que ce n'est pas le même. ---
  const other = new File([crypto.randomBytes(200000)], 'x.mp4', { type: 'video/mp4' });
  const task3 = new UploadTask({ file: other, api, env,
    expectedFingerprint: task1.fingerprint, expectedFingerprintScheme: FINGERPRINT_SCHEME });
  await assert.rejects(task3.start(), /pas celui/);
  assert.equal(task3.state, 'mismatch');

  // La vidéo est transcodée et publiée.
  let video;
  for (let i = 0; i < 120; i += 1) {
    video = (await api.getVideo(result.videoId)).video;
    if (video.status === 'failed' || (video.status === 'ready' && video.renditions.includes('720p'))) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(video.status, 'ready');
  assert.deepEqual(video.renditions, ['240p', '480p', '720p']);
});
