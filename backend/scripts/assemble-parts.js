// Assemble des morceaux .part en MP4, avec la MÊME chaîne que le serveur.
//
// Ce script est le pendant de scripts/split-to-parts.js : celui-ci découpe une
// vidéo en .part, celui-ci recolle les .part en un MP4 valide. Il réutilise les
// vraies fonctions de production de backend/src/services/ffmpeg.service.js
// (assembleMp4, supportedProtocols, concatPartsToFile) et reproduit pas à pas
// la logique de prepareFfmpegInput()/completeUpload() de
// backend/src/controllers/upload.controller.js. Un essai réussi ici prouve donc
// que le serveur saura assembler la même session, sans lancer ni le téléphone,
// ni PostgreSQL, ni l'API.
//
// Usage (depuis backend/) :
//   node scripts/assemble-parts.js 030d25ca-cf2c-4aa3-b74a-b62e98eed34e
//       assemble la session <uploadId> présente dans uploads/sessions/.
//   node scripts/assemble-parts.js "C:\chemin\vers\un\dossier"
//       assemble tous les <n>.part de ce dossier.
//   node scripts/assemble-parts.js <uploadId> --out "C:\chemin\resultat.mp4"
//       choisit l'emplacement du MP4 final (par défaut : à côté des .part,
//       nommé <uploadId>.assembled.mp4).
//
// Ce que fait le script, dans l'ordre :
//   1. Il retrouve les .part et vérifie la continuité (numéros 0,1,2... sans trou,
//      référence exacte <n>.part dans le dossier de session, taille cumulée = taille annoncée).
//   2. Il interroge le FFmpeg installé (ffmpeg -protocols) et choisit la
//      méthode d'entrée : manifeste concatf:, URL concat:, ou concaténation Node.
//   3. Il lance assembleMp4() : copie des codecs dans une enveloppe MP4, repli
//      automatique en réencodage H.264/AAC, validation par ffprobe.
//   4. Il supprime ses fichiers temporaires et affiche un résumé explicite.

const path = require('path');
const fs = require('fs/promises');
const { assembleMp4, supportedProtocols, concatPartsToFile } = require('../src/services/ffmpeg.service');
const { sessionsDir, ffmpegPath } = require('../src/config/env');

// Même plafond que upload.controller.js : l'URL concat: replace chaque nom de
// .part par son chemin dans une seule ligne de commande; au-delà de 16 000
// caractères, Windows refuse simplement d'exécuter le processus.
const MAX_CONCAT_URL_CHARS = 16000;
// Même motif que le contrôleur : l'identifiant de session est un UUID hexadécimal.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class HelpRequested extends Error {}

// Découvre un dossier : liste simple des entrées, sans erreur si absent.
async function listDirectory(dir) {
  return fs.readdir(dir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

// Retrouve le dossier des morceaux de la session.
// Deux formes d'entrée : un UUID (les .part vivent alors dans
// uploads/sessions/<uploadId>/, comme un upload réel) ou un dossier quelconque
// contenant des fichiers <n>.part.
function resolveSession(argument, forcedDir) {
  const uploadId = argument.toLowerCase();
  if (UUID_PATTERN.test(uploadId)) {
    const dir = path.resolve(forcedDir || path.join(sessionsDir, uploadId));
    return { dir, uploadId };
  }
  if (forcedDir) throw new Error('Avec --dir, la cible doit être l\'uploadId de la session.');
  return { dir: path.resolve(argument), uploadId: null };
}

// Reproduit la validation de prepareFfmpegInput() :
// - numéros consécutifs (0, 1, 2...), sans trou et sans doublon;
// - chaque fichier s'appelle exactement <n>.part, existe et n'est pas vide;
// - la somme des tailles (mesurée sur le disque) égale la taille annoncée du
//   meta.json, quand celui-ci est présent — comme côté serveur, les tailles ne
//   vivent jamais en base mais dans ce fichier de session.
async function collectParts(dir) {
  const entries = await listDirectory(dir);
  const numbers = entries
    .map((name) => name.match(/^(\d+)\.part$/i))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);

  if (!numbers.length) {
    throw new Error(`Aucun fichier <n>.part dans ${dir}. Lancez d'abord scripts/split-to-parts.js.`);
  }

  const partNames = [];
  let totalBytes = 0;
  for (let index = 0; index < numbers.length; index += 1) {
    if (numbers[index] !== index) {
      throw new Error(`Numéros non consécutifs : trou entre ${index - 1} et ${numbers[index]} (le serveur refuserait avec 409).`);
    }
    const partName = `${numbers[index]}.part`;
    const stat = await fs.stat(path.join(dir, partName));
    if (stat.size < 1) throw new Error(`Le morceau ${partName} est vide (refus serveur : 409).`);
    totalBytes += stat.size;
    partNames.push(partName);
  }

  let announced = null;
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    announced = metadata.totalSize;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (announced !== null) {
    if (totalBytes !== announced) {
      throw new Error(`La somme des .part (${totalBytes}) ne vaut pas la taille annoncée du meta.json (${announced}) : un morceau est absent ou tronqué.`);
    }
  } else {
    console.log(`Attention : meta.json absent, impossible de vérifier la taille annoncée (${totalBytes} octets mesurés).`);
  }

  return { partNames, totalBytes, announced };
}

async function parseArgs(argv) {
  const options = { target: null, dir: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      options.out = argv[i += 1];
      if (!options.out) throw new Error('--out attend un chemin de fichier .mp4.');
    } else if (argv[i] === '--dir') {
      options.dir = argv[i += 1];
      if (!options.dir) throw new Error('--dir attend un dossier.');
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      throw new HelpRequested();
    } else {
      if (options.target) throw new Error('Un seul argument cible est accepté (uploadId ou dossier).');
      options.target = argv[i];
    }
  }
  if (!options.target) throw new HelpRequested();
  return options;
}

function printHelp() {
  console.log(`Assemble des .part en MP4 avec la même chaîne que le serveur ViteVendre.

Usage :
  node scripts/assemble-parts.js <uploadId> [--dir <dossier>] [--out <fichier.mp4>]
  node scripts/assemble-parts.js <dossier contenant des .part> [--out <fichier.mp4>]

  <uploadId>       identifiant de session (UUID) présent dans uploads/sessions/
  <dossier>        dossier contenant des fichiers <n>.part
  --dir <dossier>  dossier alternatif quand la cible est un uploadId
  --out <fichier>  chemin du MP4 final (défaut : <uploadId>.assembled.mp4 dans le dossier des .part)`);
}

async function main() {
  let options;
  try {
    options = await parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      printHelp();
      return;
    }
    throw error;
  }

  // Étape 1 : localiser et valider les morceaux (mêmes contrôles 409 que le serveur).
  const { dir, uploadId } = resolveSession(options.target, options.dir);
  const { partNames, totalBytes, announced } = await collectParts(dir);

  const defaultName = uploadId ? `${uploadId}.assembled.mp4` : 'assembled.mp4';
  const outputPath = options.out ? path.resolve(options.out) : path.join(dir, defaultName);
  const cwd = dir;

  console.log(`Session                : ${uploadId}`);
  console.log(`Dossier des morceaux   : ${dir}`);
  console.log(`Morceaux               : ${partNames.length} (${totalBytes} octets au total${announced !== null ? ', taille annoncée vérifiée' : ', taille non vérifiée'})`);
  console.log(`Sortie                 : ${outputPath}`);
  console.log('');

  // Étape 2 : choisir la méthode d'entrée exactement comme prepareFfmpegInput().
  let protocols;
  try {
    protocols = await supportedProtocols();
  } catch (error) {
    throw new Error('Impossible d\'interroger FFmpeg pour choisir la méthode d\'assemblage (le serveur renverrait 503).');
  }
  console.log(`Protocoles détectés    : concatf=${protocols.has('concatf')} concat=${protocols.has('concat')}`);

  let input;
  let temporaryPath = null;
  if (protocols.has('concatf')) {
    // Chaîne prioritaire (FFmpeg >= 8) : un manifeste texte, un nom de .part par
    // ligne. FFmpeg ouvre lui-même chaque fichier, dans l'ordre, comme un seul
    // flux d'octets : Node ne copie aucun octet.
    const manifestPath = path.join(dir, 'concat.tmp');
    await fs.rm(manifestPath, { force: true });
    await fs.writeFile(manifestPath, `${partNames.join('\n')}\n`, { flag: 'wx' });
    // Chemin RELATIF du manifeste + cwd = dossier des morceaux, même choix que le
    // serveur depuis la correction des chemins absolus : FFmpeg résout tout dans le cwd.
    input = `concatf:${path.basename(manifestPath)}`;
    temporaryPath = manifestPath;
    console.log('Méthode choisie        : manifeste concatf:');
  } else {
    const concatUrl = `concat:${partNames.join('|')}`;
    if (protocols.has('concat') && concatUrl.length <= MAX_CONCAT_URL_CHARS) {
      // Chaîne universelle : le protocole concat: existe dans toutes les versions
      // de FFmpeg; les noms sont joints par | dans une seule URL.
      input = concatUrl;
      console.log('Méthode choisie        : URL concat:');
    } else {
      // Dernier repli : Node recopie les .part en streams dans un fichier unique
      // (sans jamais charger la vidéo entière en RAM), puis FFmpeg le lit normalement.
      input = path.join(dir, 'combined.tmp');
      temporaryPath = input;
      await concatPartsToFile(partNames.map((name) => path.join(dir, name)), input);
      console.log('Méthode choisie        : concaténation Node (aucun protocole concat disponible)');
    }
  }
  console.log('');

  // Étape 3 : assembler. assembleMp4() est le code de production : il tente la
  // copie des codecs (-c copy), retente en réencodage H.264/AAC si la copie
  // échoue, puis valide le résultat avec ffprobe avant de résoudre.
  try {
    await assembleMp4(input, outputPath, { cwd });
  } catch (error) {
    // Journaliser le stderr FFmpeg, comme upload_assembly_failed côté serveur :
    // c'est la seule façon de comprendre un média réel qui refuse les deux passes.
    console.error('Assemblage refusé par FFmpeg (le serveur renverrait 422).');
    if (error.details) console.error(`Fin du stderr FFmpeg :\n${String(error.details).slice(-1200)}`);
    throw error;
  } finally {
    // Étape 4 : le fichier temporaire (manifeste ou .combined.tmp) ne doit jamais survivre,
    // en succès comme en échec — même discipline que completeUpload().
    if (temporaryPath) await fs.rm(temporaryPath, { force: true });
  }

  console.log('MP4 assemblé et validé par ffprobe :');
  console.log(`  ${outputPath}`);
  console.log('');
  console.log('Inspecter la piste (codec, durée, résolution) :');
  console.log(`  & "${path.join(path.dirname(ffmpegPath), 'ffprobe.exe')}" -v error -show_entries stream=codec_name,codec_type,width,height -show_entries format=duration,size -of default=nw=1 "${outputPath}"`);
  console.log('');
  console.log('Le fichier est une vidéo librement lisible (pas un temporaire) : vous pouvez l\'ouvrir dans VLC.');
  console.log('Pour retirer le MP4 de test :');
  console.log(`  node -e "require('fs').rmSync('${outputPath.replace(/\\/g, '/')}', { force: true })"`);
}

module.exports = { resolveSession, collectParts, parseArgs };

// L'appel direct exécute l'assemblage ; un require (tests) reste inerte.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
