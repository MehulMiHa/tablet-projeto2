'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const { isIPv4 } = require('node:net');
const { MAX_UPLOAD_BYTES } = require('./frame-store');
const { familyRoute, serveFamily } = require('./family-files');
const { ApiError } = require('./jobs');

const PORT = 8787;
const LOOPBACK = '127.0.0.1';
const CONFIG_FILE = 'frame-admin.json';
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/frame-admin.css', ['frame-admin.css', 'text/css; charset=utf-8']],
  ['/frame-admin.js', ['frame-admin.js', 'application/javascript; charset=utf-8']],
  ['/eddy-icon.svg', ['eddy-icon.svg', 'image/svg+xml']],
]);
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function tailscaleAddress(address) {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

function readConfig(dataDirectory) {
  const file = path.join(dataDirectory, CONFIG_FILE);
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!validHash(config?.passwordHash) || (config.familyPasswordHash != null && !validHash(config.familyPasswordHash)) ||
      (config.address != null && !tailscaleAddress(config.address))) {
    throw new Error('Configuração de acesso às fotos inválida.');
  }
  return config;
}

function frameAdminAddress(dataDirectory) {
  try {
    const address = readConfig(dataDirectory)?.address;
    return address ? `http://${address}:${PORT}/` : null;
  } catch { return null; }
}

function validHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

function accountRole(header, passwordHash, familyPasswordHash) {
  if (typeof header !== 'string' || header.length > 200 || !/^Basic [a-z0-9+/]+={0,2}$/i.test(header)) return null;
  const login = Buffer.from(header.slice(6), 'base64');
  const digest = createHash('sha256').update(login).digest();
  const owner = timingSafeEqual(digest, passwordHash);
  const family = familyPasswordHash && timingSafeEqual(digest, familyPasswordHash);
  if (owner) return 'owner';
  return family ? 'family' : null;
}

function send(response, status, message) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: message }));
}

function photoRoute(url, method) {
  if (url === '/api/frame') return method === 'GET';
  if (url === '/api/frame/photos') return method === 'POST';
  return /^\/api\/frame\/photos\/[0-9a-f]{32}$/.test(url) && (method === 'GET' || method === 'DELETE');
}

function proxy(request, response, panelPort) {
  const headers = {};
  if (request.method === 'POST') {
    const size = Number(request.headers['content-length']);
    if (Number.isFinite(size) && size > MAX_UPLOAD_BYTES) { send(response, 413, 'A foto é demasiado grande.'); return; }
    if (request.headers['content-type'] !== 'image/jpeg') { send(response, 415, 'Escolhe uma foto em formato JPEG.'); return; }
    headers['Content-Type'] = 'image/jpeg';
    if (request.headers['content-length']) headers['Content-Length'] = request.headers['content-length'];
    if (request.headers['x-photo-name']) headers['X-Photo-Name'] = request.headers['x-photo-name'];
  }
  const upstream = http.request({ hostname: LOOPBACK, port: panelPort, path: request.url, method: request.method, headers }, incoming => {
    response.writeHead(incoming.statusCode, { 'Content-Type': incoming.headers['content-type'] || 'application/octet-stream' });
    incoming.on('error', () => response.destroy());
    incoming.pipe(response);
  });
  upstream.setTimeout(30000, () => upstream.destroy());
  upstream.on('error', () => {
    if (!response.headersSent) send(response, 502, 'O Eddy está a iniciar. Tenta novamente daqui a pouco.');
    else response.destroy();
  });
  response.on('close', () => upstream.destroy());
  request.on('error', () => upstream.destroy());
  if (request.method === 'POST') request.pipe(upstream);
  else upstream.end();
}

function createFrameAdminServer({ config, panelPort, familyFiles }) {
  const passwordHash = Buffer.from(config.passwordHash, 'hex');
  const familyPasswordHash = config.familyPasswordHash ? Buffer.from(config.familyPasswordHash, 'hex') : null;
  const server = http.createServer(async (request, response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    const host = request.headers.host;
    const port = server.address().port;
    const allowedHosts = [`${LOOPBACK}:${port}`, `localhost:${port}`];
    if (config.address) allowedHosts.push(`${config.address}:${port}`);
    if (!allowedHosts.includes(host)) { send(response, 403, 'Abre o endereço da moldura.'); return; }
    const origin = request.headers.origin;
    if ((origin && origin !== `http://${host}`) ||
        (request.url.startsWith('/api/') && request.headers['sec-fetch-site'] === 'cross-site')) {
      send(response, 403, 'Origem não autorizada.');
      return;
    }
    const asset = request.method === 'GET' && ASSETS.get(request.url);
    const isPhotoRoute = photoRoute(request.url, request.method);
    const isFamilyRoute = familyFiles && familyRoute(request.url, request.method);
    const isSessionRoute = request.method === 'GET' && request.url === '/api/session';
    if (!asset && !isPhotoRoute && !isFamilyRoute && !isSessionRoute) { send(response, 404, 'Página indisponível.'); return; }
    const role = accountRole(request.headers.authorization, passwordHash, familyPasswordHash);
    if (!role) {
      response.setHeader('WWW-Authenticate', 'Basic realm="Eddy", charset="UTF-8"');
      send(response, 401, 'Introduz o utilizador e a palavra-passe do Eddy.');
      return;
    }
    // Browser writes include a matching Origin. Native requests authenticate and use a custom header.
    const native = !origin && request.headers['x-eddy-client'] === 'android' && !request.headers['sec-fetch-site'];
    if ((request.method === 'POST' || request.method === 'DELETE') && origin !== `http://${host}` && !native) {
      send(response, 403, 'Origem não autorizada.');
      return;
    }
    if (isPhotoRoute) {
      if (role === 'owner') proxy(request, response, panelPort);
      else send(response, 403, 'Este acesso serve apenas para os ficheiros da família.');
      return;
    }
    if (isSessionRoute) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ role }));
      return;
    }
    if (isFamilyRoute) {
      try { await serveFamily(request, response, familyFiles, role === 'owner'); }
      catch (error) {
        if (response.destroyed || request.aborted) return;
        if (response.headersSent) { response.destroy(); return; }
        if (!request.complete) response.setHeader('Connection', 'close');
        if (error instanceof ApiError) send(response, error.status, error.message);
        else {
          console.error('Erro na pasta da família:', error.code || error.name);
          send(response, 500, 'O Eddy não conseguiu aceder à pasta da família.');
        }
      }
      return;
    }
    try {
      const content = await fs.promises.readFile(path.join(__dirname, 'frame-admin', asset[0]));
      response.writeHead(200, { 'Content-Type': asset[1] });
      response.end(content);
    } catch { send(response, 503, 'A página de gestão está indisponível.'); }
  });
  server.headersTimeout = 8000;
  server.requestTimeout = 10 * 60 * 1000;
  server.timeout = 30000;
  server.keepAliveTimeout = 3000;
  server.maxConnections = 30;
  return server;
}

function startConfiguredFrameAdmin({ dataDirectory, panelPort, familyFiles }) {
  try {
    const config = readConfig(dataDirectory);
    if (!config) return null;
    const server = createFrameAdminServer({ config, panelPort, familyFiles });
    server.on('error', error => console.error('A página da moldura não iniciou:', error.code || error.message));
    server.listen(PORT, LOOPBACK);
    return server;
  } catch (error) {
    console.error('A página da moldura não iniciou:', error.code || error.message);
    return null;
  }
}

module.exports = { createFrameAdminServer, startConfiguredFrameAdmin, frameAdminAddress, readConfig, tailscaleAddress, CONFIG_FILE, PORT };
