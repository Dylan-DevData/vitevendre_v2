// Découpe une vidéo en .part comme le fait le serveur pendant un upload.
//
// Le but est de reproduire HORS APPLICATION le même état disque que laisse un
// upload réel : uploads/sessions/<uploadId>/<n>.part + <uploadId>/meta.json.
// On peut alors tester l'assemblage FFmpeg directement en ligne de commande,
// sans le téléphone, sans PostgreSQL et sans l'API.
//
// Usage (depuis backend/) :
//   node scripts/split-to-parts.js chemin/vers/video.mp4
//   node scripts/split-to-parts.js chemin/vers/video.mp4 --size 1048576
//   node scripts/split-to-parts.js chemin/vers/video.mp4 --id 030d25ca-cf2c-4aa3-b74a-b62e98eed34e
//
// Le script n'envoie rien : il écrit seulement les fichiers de session, puis
// affiche les commandes FFmpeg pour réassembler et vérifier le MP4.

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { sessionsDir, ffmpegPath } = require('../src/config/env');

// Même plafond que le serveur : un .part ne dépasse jamais UPLOAD_CHUNK_MAX_BYTES.
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
// Même motif que le contrôleur : uploadId UUID hexadécimal.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const options = { input: null, size: DEFAULT_CHUNK_SIZE, id: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--size') {
      options.size = Number(argv[i += 1]);
      if (!Number.isSafeInteger(options.size) || options.size < 1) {
        throw new Error('--size doit être un nombre entier positif (octets).');
      }
      if (options.size > DEFAULT_CHUNK_SIZE) {
        throw new Error(`--size ne peut pas dépasser le plafond serveur (${DEFAULT_CHUNK_SIZE} octets).`);
      }
    } else if (argv[i] === '--id') {
      options.id = String(argv[i += 1]).toLowerCase();
      if (!UUID_PATTERN.test(options.id)) {
        throw new Error('--id doit être un UUID valide (exécutez sans --id pour en générer un).');
      }
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      throw new HelpRequested();
    } else {
      if (options.input) throw new Error('Un seul fichier d\'entrée est accepté.');
      options.input = argv[i];
    }
  }
  if (!options.input) throw new HelpRequested();
  return options;
}

class HelpRequested extends Error {}

function printHelp() {
  console.log(`Découpe une vidéo en fichiers .part identiques à ceux d'un upload ViteVendre.

Usage :
  node scripts/split-to-parts.js <video> [--size <octets>] [--id <uuid>]

  <video>         chemin du fichier source (.mp4, .mov, .webm, .3gp)
  --size <octets> taille de chaque morceau, au plafond serveur par défaut (${DEFAULT_CHUNK_SIZE})
  --id <uuid>     réutilise cet uploadId au lieu d'en générer un nouveau

Les morceaux sont écrits dans uploads/sessions/<uploadId>/<n>.part, comme le serveur.`);
}

// Écrit un morceau à la position demandée dans un .part numéroté, même convention
// que upload.model.js : sessions/<uploadId>/<n>.part, numéros consécutifs 0,1,2...
// `sessionDir` est le dossier de la session créé par l'appelant.
async function writeParts(handle, sessionDir, totalSize, chunkSize) {
  const partNames = [];
  const buffer = Buffer.alloc(chunkSize);
  let offset = 0;
  let chunkNumber = 0;
  while (offset < totalSize) {
    const length = Math.min(chunkSize, totalSize - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw new Error(`Lecture courte à l'offset ${offset} (${bytesRead}/${length} octets).`);
    const partName = `${chunkNumber}.part`;
    await fs.writeFile(path.join(sessionDir, partName), buffer.subarray(0, bytesRead), { flag: 'wx' });
    partNames.push(partName);
    offset += bytesRead;
    chunkNumber += 1;
  }
  return partNames;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      printHelp();
      return;
    }
    throw error;
  }

  const inputPath = path.resolve(options.input);
  const stat = await fs.stat(inputPath);

  const uploadId = options.id || crypto.randomUUID();
  // Comme côté serveur : tout vit dans uploads/sessions/<uploadId>/.
  const sessionDir = path.join(sessionsDir, uploadId);
  await fs.mkdir(sessionDir, { recursive: true });

  const partNames = [];
  try {
    // Un seul morceau en mémoire à la fois, comme le PATCH côté serveur.
    const handle = await fs.open(inputPath, 'r');
    try {
      partNames.push(...await writeParts(handle, sessionDir, stat.size, options.size));
    } finally {
      await handle.close();
    }
    // Même mécanisme que ensureUploadMetadata() : la taille totale attendue,
    // seule donnée de session, dans le JSON et pas en colonne SQL.
    const metadataPath = path.join(sessionDir, 'meta.json');
    await fs.writeFile(metadataPath, JSON.stringify({ totalSize: stat.size }), { flag: 'wx' });
  } catch (error) {
    // Ne pas laisser une session à moitié écrite derrière soi.
    await fs.rm(sessionDir, { recursive: true, force: true });
    throw error;
  }

  const totalParts = partNames.length;
  console.log(`Découpage terminé : ${totalParts} morceau(x) dans ${sessionDir}`);
  console.log(`  uploadId   : ${uploadId}`);
  console.log(`  taille     : ${stat.size} octets`);
  console.log(`  morceau    : ${options.size} octets (dernier plus court)`);
  console.log('');
  console.log('Réassembler avec la même chaîne que completeUpload (protocole concat, cwd = dossier de session) :');
  console.log(`  cd "${sessionDir}"`);
  console.log(`  & "${ffmpegPath}" -hide_banner -nostdin -y -i "concat:${partNames.join('|')}" -map 0:v:0 -map 0:a? -sn -dn -c copy -movflags +faststart "${uploadId}.reassembled.mp4"`);
  console.log('');
  console.log('Vérifier que le MP4 est lisible (remux réussi) :');
  console.log(`  & "${path.join(path.dirname(ffmpegPath), 'ffprobe.exe')}" -v error -show_entries format=format_name,duration,size -of default=nw=1 "${uploadId}.reassembled.mp4"`);
  console.log('');
  console.log('Assemblage complet automatisé (validation + vraie assembleMp4 du serveur) :');
  console.log(`  cd "${path.resolve(__dirname, '..')}"`);
  console.log(`  npm run parts:assemble -- ${uploadId}`);
  console.log('');
  console.log('Variante sans concat (les .part sont des plages d\'octets du même fichier, donc recoller = concaténation binaire) :');
  console.log(`  cmd /c copy /b "${partNames.map((name) => path.join(sessionDir, name)).join('"+"')}" "${path.join(sessionDir, `${uploadId}.reassembled.mp4`)}"`);
  console.log('');
  console.log('Pour nettoyer cette session de test :');
  console.log(`  node -e "require('fs').rmSync('${sessionDir.replace(/\\/g, '/')}', { recursive: true, force: true })"`);
}

module.exports = { parseArgs, writeParts };

// L'appel direct réassemble le parcours complet ; un require (tests) reste inerte.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
