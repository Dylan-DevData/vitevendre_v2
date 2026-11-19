// Test de bout en bout : upload reprenable -> transcodage HLS -> nettoyage.
// Lancer :  E2E_DATABASE_URL=postgresql://... node --test test/
// (nécessite PostgreSQL, ffmpeg et ffprobe ; ignoré si E2E_DATABASE_URL est absent)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DB = process.env.E2E_DATABASE_URL;
const skip = !DB && 'E2E_DATABASE_URL non défini';

test('upload reprenable + HLS multi-résolution + GC', { skip, timeout: 240000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vv2-e2e-'));
  process.env.DATABASE_URL = DB;
  process.env.JWT_SECRET = 'x'.repeat(40);
  process.env.UPLOAD_DIR = path.join(root, 'uploads');
  process.env.MEDIA_DIR = path.join(root, 'media');

  const { pool } = require('../src/config/db');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));

  const app = require('../src/app');
  const gc = require('../src/services/gc.service');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });

  const call = async (method, url, { token, json, body, headers = {} } = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: json ? JSON.stringify(json) : body,
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
  };

  // Vidéo verticale 1080x1920, 5 s, avec son.
  const source = path.join(root, 'in.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=25:d=5',
    '-f', 'lavfi', '-i', 'sine=f=440:d=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    '-pix_fmt', 'yuv420p', source]);
  const bytes = fs.readFileSync(source);

  const reg = await call('POST', '/api/auth/register', {
    json: { phone: '699123456', fullName: 'Test User', password: 'motdepasse123' },
  });
  assert.equal(reg.status, 201);
  const token = reg.data.token;

  const fingerprint = crypto.createHash('sha256')
    .update(bytes.subarray(0, 65536)).update(String(bytes.length)).digest('hex');
  const created = await call('POST', '/api/uploads', {
    token, json: { mime_type: 'video/mp4', total_size: bytes.length, fingerprint, caption: 'test' },
  });
  assert.equal(created.status, 201);
  const { uploadId } = created.data;
  const patch = (offset, buffer) => call('PATCH', `/api/uploads/${uploadId}`, {
    token, body: buffer, headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream' },
  });

  // 1. Morceau de 200 Ko, puis un morceau de 300 Ko.
  let offset = 0;
  let r = await patch(offset, bytes.subarray(offset, offset + 200 * 1024));
  assert.equal(r.status, 200); offset = r.data.receivedBytes;
  r = await patch(offset, bytes.subarray(offset, offset + 300 * 1024));
  assert.equal(r.status, 200); offset = r.data.receivedBytes;
  assert.equal(offset, 500 * 1024);

  // 2. Coupure réseau en plein morceau : 100 Ko envoyés sur 400 annoncés, puis socket détruit.
  await new Promise((resolve) => {
    const req = http.request(`${base}/api/uploads/${uploadId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Upload-Offset': String(offset), 'Content-Length': 400 * 1024 },
    });
    req.on('error', () => resolve());
    req.write(bytes.subarray(offset, offset + 100 * 1024), () => setTimeout(() => { req.destroy(); resolve(); }, 150));
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 3. Reprise : le serveur donne l'offset validé, les octets partiels sont ignorés.
  r = await call('GET', `/api/uploads/${uploadId}`, { token });
  assert.equal(r.data.receivedBytes, offset);
  // Mauvais offset (client en retard) -> 409 + offset réel.
  r = await patch(0, bytes.subarray(0, 1000));
  assert.equal(r.status, 409);
  assert.equal(r.data.receivedBytes, offset);
  // Même fichier renommé : reprend la même session.
  const resumed = await call('POST', '/api/uploads', {
    token, json: { mime_type: 'video/mp4', total_size: bytes.length, fingerprint },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.uploadId, uploadId);
  assert.equal(resumed.data.receivedBytes, offset);

  // 4. Fin de l'envoi avec des morceaux de 512 Ko.
  while (offset < bytes.length) {
    r = await patch(offset, bytes.subarray(offset, Math.min(offset + 512 * 1024, bytes.length)));
    assert.equal(r.status, 200);
    offset = r.data.receivedBytes;
  }
  const storedChunks = await pool.query(
    `SELECT video_id, chunk_number, part_name
     FROM upload_chunks WHERE upload_id = $1 ORDER BY chunk_number`,
    [uploadId]
  );
  let storedOffset = 0;
  const diskParts = [];
  storedChunks.rows.forEach((chunk, index) => {
    assert.equal(Number(chunk.video_id), created.data.videoId);
    assert.equal(Number(chunk.chunk_number), index);
    assert.equal(chunk.part_name, `${index}.part`);
    const part = fs.readFileSync(path.join(process.env.UPLOAD_DIR, 'sessions', uploadId, chunk.part_name));
    assert.ok(part.length > 0);
    storedOffset += part.length;
    diskParts.push(part);
  });
  assert.equal(storedOffset, bytes.length);
  assert.ok(Buffer.concat(diskParts).equals(bytes), 'les références .part doivent reconstituer la vidéo');
  const chunkColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'upload_chunks'`
  );
  assert.deepEqual(chunkColumns.rows.map((row) => row.column_name).sort(),
    ['chunk_number', 'created_at', 'part_name', 'upload_id', 'video_id']);
  const uploadColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'uploads'`
  );
  assert.ok(!uploadColumns.rows.some((row) => ['total_size', 'received_bytes'].includes(row.column_name)));
  const sessionDir = path.join(process.env.UPLOAD_DIR, 'sessions', uploadId);
  const sessionEntries = fs.readdirSync(sessionDir);
  // Pendant l'envoi : les .part + meta.json vivent dans le dossier de session, aucun .tmp égaré.
  assert.ok(sessionEntries.includes('meta.json'));
  assert.ok(sessionEntries.includes('0.part'));
  assert.equal(sessionEntries.some((name) => name.endsWith('.tmp')), false);
  const metadataFile = path.join(sessionDir, 'meta.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(metadataFile, 'utf8')), { totalSize: bytes.length });

  r = await call('POST', `/api/uploads/${uploadId}/complete`, { token });
  assert.equal(r.status, 202);
  const videoId = r.data.videoId;
  // Après l'assemblage réussi : les temporaires sont partis, .part + meta.json + le
  // manifeste concat.tmp (inputPath de FFmpeg) RESTENT — la session est ré-assemblable,
  // et le GC nettoie le dossier après son TTL.
  const remaining = fs.readdirSync(sessionDir);
  assert.ok(remaining.includes('meta.json'));
  assert.ok(remaining.includes('concat.tmp'), 'le manifeste concat.tmp doit rester');
  storedChunks.rows.forEach((chunk) => assert.ok(fs.existsSync(path.join(sessionDir, chunk.part_name)), `${chunk.part_name} doit rester après l'assemblage`));
  assert.equal(remaining.some((name) => name.endsWith('.incoming.tmp') || name === 'combined.tmp'), false);
  assert.equal(remaining.some((name) => name.endsWith('.log')), false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM upload_chunks WHERE upload_id = $1', [uploadId])).rows[0].n, 0);

  // 5. Le transcodage publie 240p+480p, puis ajoute 720p+1080p.
  let video;
  for (let i = 0; i < 200; i += 1) {
    video = (await call('GET', `/api/videos/${videoId}`, { token })).data.video;
    if (video.status === 'failed') assert.fail('transcodage en échec');
    if (video.renditions.length === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(video.status, 'ready');
  assert.deepEqual(video.renditions, ['240p', '480p', '720p', '1080p']);
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);

  const master = await fetch(`${base}${video.hlsUrl}`);
  assert.equal(master.status, 200);
  const text = await master.text();
  assert.match(text, /RESOLUTION=240x426/);   // vertical : 240 = petit côté
  assert.match(text, /RESOLUTION=1080x1920/);
  assert.match(text, /480p\/index\.m3u8/);
  const variant = await fetch(`${base}/media/videos/${videoId}/720p/index.m3u8`);
  assert.equal(variant.status, 200);
  assert.match(await variant.text(), /seg_00000\.ts/);
  assert.equal((await fetch(`${base}/media/videos/${videoId}/240p/seg_00000.ts`)).status, 200);
  assert.equal((await fetch(`${base}${video.posterUrl}`)).status, 200);
  const feed = await call('GET', '/api/videos');
  assert.equal(feed.data.videos.length, 1);
  // La source brute est supprimée après le transcodage.
  assert.equal(fs.readdirSync(path.join(process.env.UPLOAD_DIR, 'sources')).length, 0);

  // 6. Garbage collector : une session inactive depuis > 24 h est supprimée.
  const stale = await call('POST', '/api/uploads', {
    token, json: { mime_type: 'video/mp4', total_size: 5000, fingerprint: 'a'.repeat(64) },
  });
  await pool.query(`UPDATE uploads SET updated_at = now() - interval '25 hours' WHERE id = $1`, [stale.data.uploadId]);
  const result = await gc.collect();
  assert.equal(result.sessions, 1);
  const left = await pool.query('SELECT count(*)::int AS n FROM uploads WHERE id = $1', [stale.data.uploadId]);
  assert.equal(left.rows[0].n, 0);
  const staleChunks = await pool.query('SELECT count(*)::int AS n FROM upload_chunks WHERE upload_id = $1', [stale.data.uploadId]);
  assert.equal(staleChunks.rows[0].n, 0);
  assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, 'sessions', String(stale.data.uploadId))), false);
});

test('l’échelle de qualités ne dépasse jamais la source', () => {
  const { selectLadder, renditionSize } = require('../src/services/ffmpeg.service');
  const names = (info) => selectLadder(info).map((rung) => rung.name);
  assert.deepEqual(names({ width: 1080, height: 1920 }), ['240p', '480p', '720p', '1080p']);
  assert.deepEqual(names({ width: 720, height: 1280 }), ['240p', '480p', '720p']);
  assert.deepEqual(names({ width: 640, height: 360 }), ['240p']);
  assert.deepEqual(names({ width: 160, height: 90 }), ['240p']);
  const rung = selectLadder({ width: 1080, height: 1920 })[0];
  assert.deepEqual(renditionSize(rung, { width: 1080, height: 1920 }), { width: 240, height: 426 });
  const tiny = selectLadder({ width: 160, height: 90 })[0];
  assert.deepEqual(renditionSize(tiny, { width: 160, height: 90 }), { width: 160, height: 90 });
});
