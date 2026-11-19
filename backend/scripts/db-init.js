// Crée les tables puis insère les données de départ.
//   npm run db:init     -> sans rien effacer (relançable)
//   npm run db:reset    -> EFFACE tout puis recrée (développement uniquement)
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pool } = require('../src/config/db');
const { nodeEnv, sessionsDir } = require('../src/config/env');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'database', file), 'utf8');

// Avant de supprimer les anciennes colonnes de taille et BYTEA, déplace leurs valeurs
// nécessaires sur disque : la taille de session va dans .meta.json et chaque bloc dans
// son .part. On ne lit qu'un BYTEA à la fois; PostgreSQL ne garde ensuite que les refs.
async function migrateLegacyUploadFiles() {
  const { rows: uploadTables } = await pool.query("SELECT to_regclass('public.uploads') AS table_name");
  if (!uploadTables[0].table_name) return;

  const { rows: uploadColumns } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'uploads'`
  );
  const uploadColumnNames = new Set(uploadColumns.map((column) => column.column_name));
  await fsp.mkdir(sessionsDir, { recursive: true });
  if (uploadColumnNames.has('total_size')) {
    const { rows: uploads } = await pool.query('SELECT id, total_size FROM uploads');
    for (const upload of uploads) {
      const uploadId = String(upload.id);
      const target = path.join(sessionsDir, uploadId, 'meta.json');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.migration.tmp`;
      await fsp.writeFile(temporary, JSON.stringify({ totalSize: Number(upload.total_size) }));
      await fsp.rename(temporary, target);
    }
  }

  const { rows: chunkTables } = await pool.query("SELECT to_regclass('public.upload_chunks') AS table_name");
  if (!chunkTables[0].table_name) return;
  const { rows: chunkColumns } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'upload_chunks'`
  );
  const chunkColumnNames = new Set(chunkColumns.map((column) => column.column_name));
  if (!chunkColumnNames.has('data')) return;

  const { rows: chunks } = await pool.query(
    'SELECT upload_id, chunk_number FROM upload_chunks ORDER BY upload_id, chunk_number'
  );
  for (const chunk of chunks) {
    const uploadId = String(chunk.upload_id);
    const chunkNumber = Number(chunk.chunk_number);
    const partPath = path.join(sessionsDir, uploadId, `${chunkNumber}.part`);
    await fsp.mkdir(path.dirname(partPath), { recursive: true });
    const { rows } = await pool.query(
      'SELECT data FROM upload_chunks WHERE upload_id = $1 AND chunk_number = $2',
      [uploadId, chunkNumber]
    );
    const data = rows[0] && rows[0].data;
    const existing = await fsp.readFile(partPath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (data) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!existing || !existing.equals(bytes)) await fsp.writeFile(partPath, bytes);
    } else if (!existing || existing.length < 1) {
      throw new Error(`Impossible de migrer le morceau ${uploadId}/${chunkNumber} : BYTEA et .part absents.`);
    }
  }
}

async function main() {
  const reset = process.argv.includes('--reset');

  if (reset) {
    if (nodeEnv === 'production') {
      throw new Error('Reset interdit en production.');
    }
    console.log('Suppression de toutes les tables…');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }

  if (!reset) {
    console.log('Migration des anciennes tailles et morceaux BYTEA vers uploads/sessions/...');
    await migrateLegacyUploadFiles();
  }

  console.log('Création des tables…');
  await pool.query(read('schema.sql'));

  console.log('Terminé.');
}

main()
  .catch((err) => {
    console.error('Échec :', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
