// Vérifie le vrai parcours média sans base de données : .part -> MP4 -> HLS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test('FFmpeg assemble les .part référencés en MP4 puis produit les playlists HLS', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vv2-ffmpeg-parts-'));
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.JWT_SECRET ||= 'ffmpeg-test-secret-'.repeat(3);
  process.env.UPLOAD_DIR = path.join(root, 'uploads');
  process.env.MEDIA_DIR = path.join(root, 'media');

  const { ffmpegPath, sessionsDir, mediaDir } = require('../src/config/env');
  const { assembleMp4, probe, processVideo } = require('../src/services/ffmpeg.service');
  await fsp.mkdir(sessionsDir, { recursive: true });
  await fsp.mkdir(path.join(root, 'sources'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const original = path.join(root, 'original.mp4');
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=12:d=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', original,
  ]);
  const bytes = fs.readFileSync(original);
  assert.ok(bytes.length > 128);

  const uploadId = '12345678-1234-4234-8234-123456789abc';
  // Nouveau layout : un dossier par session, morceaux nommés <n>.part.
  const sessionDir = path.join(sessionsDir, uploadId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const cuts = [31, Math.floor(bytes.length / 2), bytes.length - 17];
  const bounds = [0, ...cuts, bytes.length];
  const names = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const name = `${index}.part`;
    names.push(name);
    fs.writeFileSync(path.join(sessionDir, name), bytes.subarray(bounds[index], bounds[index + 1]));
  }

  const manifestName = 'concat.tmp';
  fs.writeFileSync(path.join(sessionDir, manifestName), `${names.join('\n')}\n`);
  const assembled = path.join(root, 'sources', '1.mp4');
  await assembleMp4(`concatf:${manifestName}`, assembled, { cwd: sessionDir });
  const info = await probe(assembled);
  assert.equal(info.width, 160);
  assert.equal(info.height, 120);

  let ready;
  await processVideo(assembled, 1, {
    onReady: async (metadata) => { ready = metadata; },
    onRenditions: async () => {},
  });
  assert.ok(ready && ready.renditions.includes('240p'));
  assert.ok(fs.existsSync(path.join(mediaDir, 'videos', '1', 'master.m3u8')));
  assert.ok(fs.existsSync(path.join(mediaDir, 'videos', '1', '240p', 'index.m3u8')));
});
