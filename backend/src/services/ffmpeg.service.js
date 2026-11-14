const fs = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { ffmpegPath, ffprobePath, mediaDir, maxVideoBytes } = require('../config/env');
const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);

// Échelle de qualités. "short" = petit côté de l'image (la largeur pour une vidéo
// verticale 9:16) : une vidéo TikTok "480p" fait donc 480x854, pas 270x480.
const LADDER = [
  { name: '240p', short: 240, videoKbps: 300, maxKbps: 360 },
  { name: '480p', short: 480, videoKbps: 800, maxKbps: 960 },
  { name: '720p', short: 720, videoKbps: 1800, maxKbps: 2160 },
  { name: '1080p', short: 1080, videoKbps: 4000, maxKbps: 4800 },
];
const AUDIO_KBPS = 64;
// Étape 1 (rapide) : ces qualités rendent la vidéo visible. Le reste est ajouté ensuite.
const FIRST_PASS = ['240p', '480p'];
const MAX_FPS = 30;

const even = (value) => Math.max(2, Math.round(value / 2) * 2);

async function assertAvailable() {
  try {
    await execFileAsync(ffmpegPath, ['-version']);
    await execFileAsync(ffprobePath, ['-version']);
  } catch (error) {
    const unavailable = new Error('FFmpeg et FFprobe doivent être installés (PATH ou FFMPEG_PATH/FFPROBE_PATH).');
    unavailable.status = 503;
    unavailable.cause = error;
    throw unavailable;
  }
}

async function probe(filePath) {
  // ffprobe lit les métadonnées (durée, dimensions, pistes), pas tout le média en Buffer Node.
  const { stdout } = await execFileAsync(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
    { maxBuffer: 8 * 1024 * 1024 }
  );
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((s) => s.codec_type === 'video' && s.width && s.height);
  const duration = Number(data.format && data.format.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) {
    const error = new Error('Le fichier ne contient pas une vidéo lisible.');
    error.status = 415;
    throw error;
  }
  // FFmpeg applique la rotation (vidéos de téléphone) : on raisonne sur la taille affichée.
  let rotation = 0;
  const sideData = (video.side_data_list || []).find((item) => item.rotation !== undefined);
  if (sideData) rotation = Number(sideData.rotation);
  else if (video.tags && video.tags.rotate) rotation = Number(video.tags.rotate);
  rotation = ((Math.round(rotation) % 360) + 360) % 360;
  const swapped = rotation === 90 || rotation === 270;

  const [num, den] = String(video.r_frame_rate || '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;

  return {
    width: swapped ? video.height : video.width,
    height: swapped ? video.width : video.height,
    duration,
    fps,
    hasAudio: (data.streams || []).some((s) => s.codec_type === 'audio'),
  };
}

// Qualités à produire : jamais plus grandes que la source (pas de sur-échantillonnage).
function selectLadder(info) {
  const short = Math.min(info.width, info.height);
  const rungs = LADDER.filter((rung) => rung.short <= short);
  // Source minuscule (< 240) : une seule qualité, à la taille d'origine.
  return rungs.length ? rungs : [{ ...LADDER[0], short: even(short) }];
}

function renditionSize(rung, info) {
  const portrait = info.width <= info.height;
  if (portrait) {
    const width = Math.min(rung.short, even(info.width));
    return { width: even(width), height: even((width * info.height) / info.width) };
  }
  const height = Math.min(rung.short, even(info.height));
  return { width: even((height * info.width) / info.height), height: even(height) };
}

// Construit UNE commande FFmpeg : la source est décodée une seule fois puis dupliquée
// (split) vers chaque qualité, au lieu de relancer un processus par résolution.
function buildHlsArgs(input, outDir, rungs, info) {
  const sizes = rungs.map((rung) => renditionSize(rung, info));
  const n = rungs.length;
  const labels = rungs.map((_, i) => `[s${i}]`).join('');
  // split réutilise le décodage de la source et alimente une branche de filtre par résolution.
  const chains = [
    `[0:v]${info.fps > MAX_FPS + 0.5 ? `fps=${MAX_FPS},` : ''}split=${n}${labels}`,
    ...sizes.map((size, i) => `[s${i}]scale=${size.width}:${size.height}:flags=bicubic,setsar=1,format=yuv420p[v${i}]`),
  ];

  const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-filter_complex', chains.join(';')];
  rungs.forEach((_, i) => {
    args.push('-map', `[v${i}]`);
    if (info.hasAudio) args.push('-map', '0:a:0');
  });
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*2)');
  rungs.forEach((rung, i) => {
    args.push(`-b:v:${i}`, `${rung.videoKbps}k`, `-maxrate:v:${i}`, `${rung.maxKbps}k`,
      `-bufsize:v:${i}`, `${rung.maxKbps * 2}k`);
  });
  if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ac', '2', '-ar', '44100');
  args.push(
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments', '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(outDir, '%v', 'seg_%05d.ts'),
    '-var_stream_map', rungs.map((rung, i) => `v:${i}${info.hasAudio ? `,a:${i}` : ''},name:${rung.name}`).join(' '),
    path.join(outDir, '%v', 'index.m3u8')
  );
  return { args, sizes };
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    child.stderr.on('data', (data) => { tail = (tail + data.toString()).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const error = new Error(`FFmpeg a échoué (code ${code}) : ${tail.trim().split('\n').pop()}`);
      error.details = tail;
      return reject(error);
    });
  });
}

async function transcodeRungs(input, outDir, rungs, info) {
  await Promise.all(rungs.map((rung) => fs.mkdir(path.join(outDir, rung.name), { recursive: true })));
  const { args, sizes } = buildHlsArgs(input, outDir, rungs, info);
  await run(args);
  return rungs.map((rung, i) => ({ ...rung, ...sizes[i] }));
}

async function extractPoster(input, posterPath, info) {
  const portrait = info.width <= info.height;
  await run([
    '-hide_banner', '-nostdin', '-y', '-ss', String(Math.min(1, info.duration / 2)), '-i', input,
    '-frames:v', '1', '-vf', portrait ? 'scale=480:-2' : 'scale=-2:480', '-q:v', '4', posterPath,
  ]);
}

// Le master est écrit avec les vrais débits (vidéo + audio) de chaque qualité.
async function writeMaster(outDir, built, hasAudio) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  [...built].sort((a, b) => a.maxKbps - b.maxKbps).forEach((rung) => {
    const bandwidth = Math.round((rung.maxKbps + (hasAudio ? AUDIO_KBPS : 0)) * 1000);
    const average = Math.round((rung.videoKbps + (hasAudio ? AUDIO_KBPS : 0)) * 1000);
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${average},RESOLUTION=${rung.width}x${rung.height},NAME="${rung.name}"`,
      `${rung.name}/index.m3u8`
    );
  });
  lines.push('');
  // Écriture atomique : un lecteur ne voit jamais un master à moitié écrit.
  const target = path.join(outDir, 'master.m3u8');
  await fs.writeFile(`${target}.tmp`, lines.join('\n'), 'utf8');
  await fs.rename(`${target}.tmp`, target);
}

/**
 * Transcode une vidéo en HLS multi-résolution.
 *  1. 240p + 480p  -> onReady() : la vidéo est publiée, lisible tout de suite.
 *  2. 720p + 1080p -> en arrière-plan, puis onRenditions() met à jour la liste.
 */
async function processVideo(sourcePath, videoId, { onReady, onRenditions }) {
  const stat = await fs.stat(sourcePath);
  if (maxVideoBytes > 0 && stat.size > maxVideoBytes) {
    const error = new Error('La vidéo dépasse la taille maximale autorisée.');
    error.status = 413;
    throw error;
  }
  await assertAvailable();
  const info = await probe(sourcePath);
  const rungs = selectLadder(info);
  let first = rungs.filter((rung) => FIRST_PASS.includes(rung.name));
  if (!first.length) first = rungs;
  const later = rungs.filter((rung) => !first.includes(rung));

  const outDir = path.join(mediaDir, 'videos', String(videoId));
  await fs.mkdir(outDir, { recursive: true });

  // Première passe légère : 240p/480p pour rendre la vidéo consultable rapidement.
  const built = await transcodeRungs(sourcePath, outDir, first, info);
  await extractPoster(sourcePath, path.join(outDir, 'poster.jpg'), info);
  await writeMaster(outDir, built, info.hasAudio);
  await onReady({
    width: info.width,
    height: info.height,
    duration: info.duration,
    renditions: built.map((rung) => rung.name),
    posterKey: path.posix.join('videos', String(videoId), 'poster.jpg'),
  });

  // Les qualités plus coûteuses sont ajoutées après publication des premières.
  if (later.length) {
    try {
      const extra = await transcodeRungs(sourcePath, outDir, later, info);
      const all = [...built, ...extra];
      // Ordre voulu : si la base échoue, le master (écrit en dernier) ne référence pas
      // encore les nouvelles qualités et le nettoyage ci-dessous ne casse rien.
      await onRenditions(all.map((rung) => rung.name));
      await writeMaster(outDir, all, info.hasAudio);
    } catch (error) {
      // Non bloquant : la vidéo reste lisible avec les qualités déjà publiées.
      logger.error('hls_extra_renditions_failed', { videoId, message: error.message });
      await Promise.all(later.map((rung) => fs.rm(path.join(outDir, rung.name), { recursive: true, force: true })));
    }
  }
}

module.exports = {
  assertAvailable, probe, selectLadder, renditionSize, buildHlsArgs, processVideo, LADDER,
};
