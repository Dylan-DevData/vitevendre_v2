// Temps réel (SSE), J'aime, visibilité des vidéos en traitement.
// Lancer :  E2E_DATABASE_URL=postgresql://... node --test --test-concurrency=1
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DB = process.env.E2E_DATABASE_URL;
const skip = !DB && 'E2E_DATABASE_URL non défini';

test('SSE video.ready, likes, visibilité des vidéos non publiées', { skip, timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vv2-social-'));
  process.env.DATABASE_URL = DB;
  process.env.JWT_SECRET = 'w'.repeat(40);
  process.env.UPLOAD_DIR = path.join(root, 'uploads');
  process.env.MEDIA_DIR = path.join(root, 'media');
  const { pool } = require('../src/config/db');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  const app = require('../src/app');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const abort = new AbortController();
  t.after(async () => { abort.abort(); server.closeAllConnections(); server.close(); await pool.end(); });

  const call = async (method, url, { token, json, body, headers = {} } = {}) => {
    const res = await fetch(base + url, {
      method, body: json ? JSON.stringify(json) : body,
      headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  const register = async (phone, fullName) =>
    (await call('POST', '/api/auth/register', { json: { phone, fullName, password: 'motdepasse123' } })).data;
  const alice = await register('600000001', 'Alice');
  const bob = await register('600000002', 'Bob');

  // Flux SSE d'Alice (jeton passé en ?token=, comme EventSource).
  const received = [];
  const stream = await fetch(`${base}/api/events?token=${alice.token}`, { signal: abort.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const part of stream.body) {
        buffer += decoder.decode(part, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const event = /^event: (.+)$/m.exec(block);
          const data = /^data: (.+)$/m.exec(block);
          if (event && data) received.push({ event: event[1], data: JSON.parse(data[1]) });
        }
      }
    } catch (error) { /* flux fermé en fin de test */ }
  })();
  assert.equal((await fetch(`${base}/api/events`)).status, 401, 'SSE sans jeton refusé');

  const src = path.join(root, 'in.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=480x854:r=25:d=2', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', src]);
  const bytes = fs.readFileSync(src);
  const created = (await call('POST', '/api/uploads', { token: alice.token, json: {
    mime_type: 'video/mp4', total_size: bytes.length, fingerprint: crypto.createHash('sha256').update(bytes).digest('hex'), caption: 'salut',
  } })).data;
  const sent = await call('PATCH', `/api/uploads/${created.uploadId}`, { token: alice.token, body: bytes,
    headers: { 'Upload-Offset': '0', 'Content-Type': 'application/octet-stream' } });
  assert.equal(sent.status, 200);
  assert.equal((await call('POST', `/api/uploads/${created.uploadId}/complete`, { token: alice.token })).status, 202);
  const videoId = created.videoId;

  // En traitement : visible par Alice seule, jamais dans le fil public, média non servi.
  assert.equal((await call('GET', `/api/videos/${videoId}`, { token: bob.token })).status, 404);
  assert.equal((await call('GET', '/api/videos')).data.videos.length, 0);
  const mine = await call('GET', '/api/videos?author=me', { token: alice.token });
  assert.equal(mine.data.videos.length, 1);
  assert.equal(mine.data.videos[0].status, 'processing');
  assert.equal((await call('GET', '/api/videos?author=me', { token: bob.token })).data.videos.length, 0);
  assert.equal((await call('GET', '/api/videos?author=me')).status, 401);
  assert.equal((await fetch(`${base}/media/videos/${videoId}/master.m3u8`)).status, 404);
  assert.equal((await call('POST', `/api/videos/${videoId}/like`, { token: bob.token })).status, 404, 'pas de like avant publication');

  // L'événement temps réel arrive tout seul.
  for (let i = 0; i < 120 && !received.some((e) => e.event === 'video.ready'); i += 1) await new Promise((r) => setTimeout(r, 250));
  const ready = received.find((e) => e.event === 'video.ready');
  assert.ok(ready, 'video.ready reçu en temps réel');
  assert.equal(ready.data.videoId, videoId);
  assert.ok(received.some((e) => e.event === 'feed.new'));
  assert.deepEqual(ready.data.renditions, ['240p', '480p']);

  // Publiée : visible par tous ; J'aime idempotent.
  assert.equal((await call('GET', `/api/videos/${videoId}`, { token: bob.token })).status, 200);
  let like = await call('POST', `/api/videos/${videoId}/like`, { token: bob.token });
  assert.deepEqual(like.data, { liked: true, likeCount: 1 });
  like = await call('POST', `/api/videos/${videoId}/like`, { token: bob.token });
  assert.equal(like.data.likeCount, 1, 'double like = un seul like');
  const asBob = (await call('GET', '/api/videos', { token: bob.token })).data.videos[0];
  assert.equal(asBob.likedByMe, true);
  assert.equal(asBob.likeCount, 1);
  assert.equal((await call('GET', '/api/videos', { token: alice.token })).data.videos[0].likedByMe, false);
  like = await call('DELETE', `/api/videos/${videoId}/like`, { token: bob.token });
  assert.deepEqual(like.data, { liked: false, likeCount: 0 });
  assert.equal((await call('POST', `/api/videos/${videoId}/like`)).status, 401);
});
