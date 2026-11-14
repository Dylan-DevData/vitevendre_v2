'use strict';
// Vérifie la syntaxe de tous les modules du client (ES modules).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : [];
  });
}

const root = path.join(__dirname, '..', 'www', 'js');
let failed = 0;
for (const file of walk(root)) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(file) });
  if (result.status !== 0) { failed += 1; console.error(`${path.relative(root, file)}\n${result.stderr}`); }
}
console.log(failed ? `${failed} fichier(s) en erreur` : 'Syntaxe OK');
process.exit(failed ? 1 : 0);
