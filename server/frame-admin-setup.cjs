'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { readConfig, tailscaleAddress, CONFIG_FILE, PORT } = require('./frame-admin-server');

function main() {
  const args = process.argv.slice(2);
  const rotate = args.includes('--rotate');
  const addresses = args.filter(argument => argument !== '--rotate');
  if (addresses.length > 1 || (addresses.length && !tailscaleAddress(addresses[0]))) {
    throw new Error('Usa: node frame-admin-setup.cjs [IP Tailscale do tablet] [--rotate]');
  }
  const directory = path.join(__dirname, 'data');
  const current = readConfig(directory);
  const address = addresses[0] || current?.address || null;
  const password = !current || rotate ? randomBytes(24).toString('base64url') : null;
  const passwordHash = password ? createHash('sha256').update(`eddy:${password}`).digest('hex') : current.passwordHash;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, CONFIG_FILE);
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ address, passwordHash }) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  console.log(`Página das fotos: http://${address || '127.0.0.1'}:${PORT}/`);
  console.log('Utilizador: eddy');
  if (password) console.log(`Palavra-passe (guarda-a agora): ${password}`);
  else console.log('Segue a usar a palavra-passe anterior. Usa --rotate para gerar outra.');
  console.log('Reinicia o servidor eddy-server para aplicar esta configuração.');
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
