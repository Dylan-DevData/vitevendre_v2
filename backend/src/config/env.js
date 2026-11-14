require('dotenv').config();
const path = require('path');

const required = ['DATABASE_URL', 'JWT_SECRET'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Variables manquantes dans .env : ${missing.join(', ')}`);
  console.error('Copiez .env.example en .env puis renseignez les valeurs.');
  process.exit(1);
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} doit être un entier strictement positif.`);
  }
  return value;
}

const maxVideoBytes = process.env.MAX_VIDEO_BYTES ? Number(process.env.MAX_VIDEO_BYTES) : 0;
if (!Number.isSafeInteger(maxVideoBytes) || maxVideoBytes < 0) {
  throw new Error('MAX_VIDEO_BYTES doit être 0 (sans plafond) ou un entier positif en octets.');
}

const uploadChunkMaxBytes = positiveIntegerEnv('UPLOAD_CHUNK_MAX_BYTES', 4 * 1024 * 1024);
if (uploadChunkMaxBytes < 64 * 1024 || uploadChunkMaxBytes > 16 * 1024 * 1024) {
  throw new Error('UPLOAD_CHUNK_MAX_BYTES doit être compris entre 65536 et 16777216 octets.');
}

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  uploadDir,
  sessionsDir: path.join(uploadDir, 'sessions'), // <upload_id>.tmp (écriture append-only)
  sourcesDir: path.join(uploadDir, 'sources'),   // vidéo complète en attente de transcodage
  mediaDir: process.env.MEDIA_DIR || path.join(__dirname, '..', '..', 'media'),
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  maxVideoBytes,
  uploadChunkMaxBytes,
  uploadSessionTtlHours: positiveIntegerEnv('UPLOAD_SESSION_TTL_HOURS', 24),
  gcIntervalMinutes: positiveIntegerEnv('GC_INTERVAL_MINUTES', 60),
  transcodeConcurrency: positiveIntegerEnv('TRANSCODE_CONCURRENCY', 1),
  requestTimeoutMs: positiveIntegerEnv('REQUEST_TIMEOUT_MS', 15 * 60 * 1000),
  headersTimeoutMs: positiveIntegerEnv('HEADERS_TIMEOUT_MS', 60 * 1000),
};
