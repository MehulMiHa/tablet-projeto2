'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { RobotClient } = require('./robot-client');
const { HomeClients } = require('./home-clients');
const { FrameStore, PHOTO_ID, uploadImage } = require('./frame-store');
const { normalizeRobot, normalizeRooms, withRobotLocation, unknownLocation } = require('./normalize');
const { Jobs, ApiError } = require('./jobs');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json'
};

function readJson(filename, fallback) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return fallback; }
}

function loadConfig(filename = process.env.EDDY_CONFIG || path.join(__dirname, 'config.local.json')) {
  const config = readJson(filename, null);
  if (!config) throw new Error('Falta o ficheiro de configuração local do Eddy.');
  return config;
}

function createApp(config, dependencies = {}) {
  const startedAt = Date.now();
  const robot = dependencies.robot || new RobotClient(config.robot);
  const home = dependencies.home || new HomeClients(config);
  const publicRoot = dependencies.publicRoot || path.resolve(__dirname, '..');
  const dataDirectory = config.dataDir || path.join(__dirname, 'runtime');
  const frame = dependencies.frame || new FrameStore(path.join(dataDirectory, 'frame'));
  let frameUploads = 0;
  const cacheFile = dependencies.persist === false ? null : path.join(dataDirectory, 'last-state.json');
  const cached = cacheFile ? readJson(cacheFile, {}) : {};
  const initialConnection = () => ({ online: false, error: 'A estabelecer ligação', updatedAt: null });
  const state = {
    connections: { hue: initialConnection(), robot: initialConnection(), sync: initialConnection() },
    lights: cached.lights || { items: [] }, sync: { active: null },
    presence: { motion: null, online: false, stale: true, revision: null, updatedAt: null, changedAt: null, sensorIds: [] },
    robot: cached.robot ? withRobotLocation({ ...cached.robot, online: false }, cached.rooms || []) : {
      online: false, stateCode: null, state: 'unknown', label: 'A ligar ao Rocky', phase: 'unknown',
      battery: null, cleanTimeSeconds: null, cleanAreaM2: null, fanPower: null, fanLabel: null,
      updatedAt: null, alerts: [], currentJob: null, location: unknownLocation(), currentRoomId: null, targetRoomId: null
    },
    rooms: cached.rooms || [],
    weather: cached.weather || { outdoorTemperature: null, indoorTemperature: null, rainProbability: null, updatedAt: null }
  };
  const pending = new Map();
  const polled = {};
  const clients = new Set();
  let mode = 'idle';
  let lastClient = 0;
  let closed = false;
  let tickTimer = null;
  let heartbeat = null;
  let lastSaved = 0;
  let savedAlerts = '';
  let map = null;
  const mapVersions = new Map();
  const revision = { hue: 0, sync: 0 };

  function observePresence(event) {
    const confirmed = event.online === true && event.stale !== true && typeof event.motion === 'boolean' && typeof event.signature === 'string';
    if (!confirmed) {
      state.presence = { ...state.presence, motion: null, online: false, stale: true };
      emit({ type: 'state' });
      return;
    }
    state.presence = {
      motion: event.motion, online: true, stale: false, revision: createHash('sha256').update(event.signature).digest('hex'),
      updatedAt: Date.now(), changedAt: event.changedAt || null, sensorIds: event.sensorIds || []
    };
    // Consumers fetch the versioned current state; repeated snapshots are harmless.
    emit({ type: 'state' });
  }

  function emit(event) {
    const message = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of clients) {
      if (response.writableLength > 65536) { response.end(); clients.delete(response); }
      else response.write(message);
    }
  }

  function persist() {
    if (!cacheFile) return;
    const alerts = JSON.stringify(state.robot.alerts);
    if (Date.now() - lastSaved < 30000 && alerts === savedAlerts) return;
    try {
      fs.mkdirSync(dataDirectory, { recursive: true });
      fs.writeFileSync(cacheFile + '.tmp', JSON.stringify({ robot: state.robot, lights: state.lights, rooms: state.rooms, weather: state.weather }));
      fs.renameSync(cacheFile + '.tmp', cacheFile);
      lastSaved = Date.now();
      savedAlerts = alerts;
    } catch (error) { console.error('Não foi possível guardar o último estado:', error.code || 'erro de escrita'); }
  }

  async function runPoll(name, operation) {
    if (pending.has(name)) return pending.get(name);
    const task = Promise.resolve().then(operation).finally(() => {
      polled[name] = Date.now();
      pending.delete(name);
    });
    pending.set(name, task);
    return task;
  }

  function connection(name, error) {
    const previous = state.connections[name];
    state.connections[name] = error ? {
      online: false, error: error.message || 'Sem ligação', updatedAt: previous.updatedAt
    } : { online: true, error: null, updatedAt: Date.now() };
  }

  function pollRobot() {
    return runPoll('robot', async () => {
      try {
        const raw = await robot.call('status');
        state.robot = normalizeRobot(raw, state.robot, Date.now(), state.rooms);
        jobs.observeStatus(state.robot);
        connection('robot', state.robot.online ? null : new Error('O aspirador está sem ligação.'));
        persist();
      } catch (error) {
        state.robot = withRobotLocation({ ...state.robot, online: false }, state.rooms);
        connection('robot', error);
      }
      emit({ type: 'state', robotUpdatedAt: state.robot.updatedAt });
      return state.robot;
    });
  }

  function pollLights() {
    return runPoll('hue', async () => {
      const expected = revision.hue;
      try {
        const received = await home.lights();
        if (expected === revision.hue) { state.lights = received; connection('hue'); persist(); }
      } catch (error) {
        if (expected === revision.hue) {
          connection('hue', error);
          observePresence({ motion: null });
        }
      }
    });
  }

  function pollSync() {
    return runPoll('sync', async () => {
      const expected = revision.sync;
      try {
        const received = await home.syncState();
        if (expected === revision.sync) { state.sync = received; connection('sync'); }
      } catch (error) { if (expected === revision.sync) connection('sync', error); }
    });
  }

  async function changeSync(active) {
    const expected = ++revision.sync;
    try {
      const received = await home.setSync(active);
      if (expected === revision.sync) {
        state.sync = received;
        connection('sync');
        emit({ type: 'state' });
      }
      return received;
    } catch (error) {
      if (expected === revision.sync) connection('sync', error);
      throw error;
    }
  }

  function pollRooms() {
    return runPoll('rooms', async () => {
      try {
        const data = await robot.call('rooms');
        state.rooms = normalizeRooms(data.rooms, data.maps);
        state.robot = withRobotLocation(state.robot, state.rooms);
        delete state.roomsError;
        persist();
        emit({ type: 'state', robotUpdatedAt: state.robot.updatedAt });
      } catch (error) {
        if (!state.rooms.length) state.roomsError = error.message;
      }
    });
  }

  function pollWeather() {
    return runPoll('weather', async () => {
      try { state.weather = await home.weather(); persist(); } catch { /* Last confirmed weather retains its timestamp. */ }
    });
  }

  function namedMap(currentMap) {
    const currentRoomId = Number.isInteger(currentMap.currentRoomId) && currentMap.currentRoomId > 0 ? currentMap.currentRoomId : null;
    const room = state.rooms.find(room => room.id === currentRoomId);
    return {
      ...currentMap, currentRoomId,
      currentRoomName: room ? room.name : undefined,
      currentRoomSource: currentRoomId === null ? null : 'map.vacuum_room'
    };
  }

  async function getMap() {
    if (map && Date.now() - map.updatedAt < 30000) return namedMap(map);
    const receivedMap = await runPoll('map', async () => {
      const received = await robot.call('map');
      const image = Buffer.from(received.imageBase64 || '', 'base64');
      if (image.length < 24 || image.length > 10 * 1024 * 1024 || !Number.isInteger(received.width) || !Number.isInteger(received.height)) throw new ApiError('O Rocky ainda não devolveu um mapa válido.', 502);
      const updatedAt = Date.now();
      map = { ...received, image, imageBase64: undefined, updatedAt, imageUrl: `/api/robot/map.png?mapVersion=${updatedAt}` };
      // A second consumer can refresh the map between metadata and PNG reads.
      // Keep both snapshots so each marker/calibration uses its exact image.
      mapVersions.set(String(updatedAt), map);
      while (mapVersions.size > 2) mapVersions.delete(mapVersions.keys().next().value);
      return map;
    });
    return namedMap(receivedMap);
  }

  const jobs = new Jobs({
    robot,
    getStatus: force => force ? pollRobot() : state.robot,
    getRooms: () => state.rooms,
    stateFile: dependencies.persist === false ? null : path.join(dataDirectory, 'jobs.json'),
    onChange: currentJob => {
      state.robot.currentJob = currentJob;
      emit({ type: 'state' });
    }
  });
  state.robot.currentJob = jobs.snapshot();

  function snapshot() {
    return { now: Date.now(), ...state, robot: { ...state.robot, currentJob: jobs.snapshot() }, alerts: state.robot.alerts || [] };
  }

  function allowedOrigin(origin) {
    return !origin || [
      'http://127.0.0.1:3000', 'http://localhost:3000', 'https://mehulmiha.github.io',
      ...(config.allowedOrigins || [])
    ].includes(origin.toLowerCase());
  }

  function send(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  }

  async function body(request) {
    let length = 0;
    const chunks = [];
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 65536) throw new ApiError('Pedido demasiado grande.', 413);
      chunks.push(chunk);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch { throw new ApiError('O pedido não contém dados válidos.'); }
  }

  function validateLightControl(data) {
    const known = ['sanca', ...Object.keys(config.hue?.lights || {})];
    if (!Array.isArray(data.ids) || !data.ids.length || data.ids.length > 9 || data.ids.some(id => !known.includes(id))) throw new ApiError('Escolhe as luzes que queres ajustar.');
    if (data.on !== undefined && typeof data.on !== 'boolean') throw new ApiError('Estado de luz inválido.');
    if (data.brightness !== undefined && (!Number.isFinite(data.brightness) || data.brightness < 1 || data.brightness > 100)) throw new ApiError('O brilho deve ficar entre 1% e 100%.');
    if (data.temperature !== undefined && (!Number.isFinite(data.temperature) || data.temperature < 2000 || data.temperature > 6500)) throw new ApiError('A temperatura deve ficar entre 2000 K e 6500 K.');
    if (data.on === undefined && data.brightness === undefined && data.temperature === undefined) throw new ApiError('Escolhe um ajuste para as luzes.');
    return [...new Set(data.ids)];
  }

  function sendAlbum(response, status, album) {
    const manageUrl = dependencies.frameAdminAddress?.();
    send(response, status, manageUrl ? { ...album, manageUrl } : album);
  }

  async function serveFrame(request, response, pathname) {
    // The panel API stays private even though legacy household routes support extra CORS origins.
    const port = request.socket.localPort;
    const host = (request.headers.host || '').toLowerCase();
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) ||
        (request.headers.origin && request.headers.origin.toLowerCase() !== `http://${host}`)) {
      throw new ApiError('Origem não autorizada.', 403);
    }
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const method = request.method;
    try {
      if (pathname === '/api/frame' && method === 'GET') {
        sendAlbum(response, 200, await frame.list());
        return;
      }
      let changed;
      let status = 200;
      if (pathname === '/api/frame/settings' && method === 'PUT') {
        const data = await body(request);
        if (typeof data.enabled !== 'boolean') throw new ApiError('Escolhe se queres ligar ou desligar a moldura.');
        changed = await frame.setEnabled(data.enabled);
      } else if (pathname === '/api/frame/photos' && method === 'POST') {
        if (frameUploads >= 2) throw new ApiError('Já há fotografias a chegar. Tenta novamente dentro de instantes.', 429);
        frameUploads++;
        try { changed = await frame.add(await uploadImage(request), request.headers['x-photo-name']); }
        finally { frameUploads--; }
        status = 201;
      } else {
        const id = pathname.slice('/api/frame/photos/'.length);
        if (!pathname.startsWith('/api/frame/photos/') || !PHOTO_ID.test(id)) throw new ApiError('Fotografia não encontrada.', 404);
        if (method === 'GET') {
          const file = await frame.open(id);
          response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' });
          await pipeline(file.createReadStream(), response);
          return;
        }
        if (method !== 'DELETE') throw new ApiError('Rota não encontrada.', 404);
        changed = await frame.remove(id);
      }
      emit({ type: 'frame', revision: changed.revision });
      sendAlbum(response, status, changed);
    } catch (error) {
      if (error instanceof ApiError || response.headersSent) throw error;
      console.error('Erro ao aceder à moldura:', error.code || error.name);
      throw new ApiError('A moldura não conseguiu aceder às fotografias guardadas.', 500);
    }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(request.url, 'http://127.0.0.1:3000');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/api/frame' || pathname.startsWith('/api/frame/')) {
        await serveFrame(request, response, pathname);
        return;
      }
      const origin = request.headers.origin;
      if (!allowedOrigin(origin)) { send(response, 403, { error: 'Origem não autorizada.' }); return; }
      if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
        response.end();
        return;
      }
      if (pathname === '/api/health' && request.method === 'GET') {
        send(response, 200, { ok: true, version: '2.0.0', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
        return;
      }
      if (pathname === '/api/state' && request.method === 'GET') {
        const requested = url.searchParams.get('mode');
        if (['active', 'idle', 'sleep'].includes(requested)) mode = requested;
        lastClient = Date.now();
        send(response, 200, snapshot());
        return;
      }
      if (pathname === '/api/events' && request.method === 'GET') {
        if (clients.size >= 12) throw new ApiError('Existem demasiadas ligações ao painel.', 429);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write('retry: 5000\n\n');
        response.write('data: {"type":"state"}\n\n');
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }
      if (pathname === '/api/lights/control' && request.method === 'POST') {
        const data = await body(request);
        const ids = validateLightControl(data);
        revision.hue++;
        try { state.lights = await home.controlLights(ids, data); connection('hue'); }
        catch (error) { connection('hue', error); pollLights().catch(() => {}); throw error; }
        emit({ type: 'state' });
        send(response, 200, { ok: true, lights: state.lights, warnings: state.lights.warnings || [] });
        return;
      }
      if (pathname === '/api/sync' && request.method === 'POST') {
        const data = await body(request);
        if (typeof data.active !== 'boolean') throw new ApiError('Estado de sincronização inválido.');
        const sync = await changeSync(data.active);
        send(response, 200, { ok: true, sync });
        return;
      }
      if (pathname === '/api/robot/clean' && request.method === 'POST') {
        const data = await body(request);
        if (data.zones && data.zones.length) {
          const currentMap = await getMap();
          if (!Array.isArray(currentMap.calibration) || currentMap.calibration.length < 3) throw new ApiError('Aguarda pela calibração do mapa antes de selecionar uma zona.', 503);
        }
        send(response, 202, jobs.start(data));
        return;
      }
      if (pathname === '/api/robot/control' && request.method === 'POST') {
        const result = await jobs.control(await body(request));
        pollRobot().catch(() => {});
        send(response, result.ok ? 200 : 502, result);
        return;
      }
      if (pathname === '/api/robot/map' && request.method === 'GET') {
        const currentMap = await getMap();
        const { image, ...metadata } = currentMap;
        send(response, 200, metadata);
        return;
      }
      if (pathname === '/api/robot/map.png' && request.method === 'GET') {
        const version = url.searchParams.get('mapVersion');
        if (version !== null && !/^\d{1,16}$/.test(version)) throw new ApiError('A versão do mapa é inválida.', 400);
        const currentMap = version === null ? await getMap() : mapVersions.get(version);
        if (!currentMap) throw new ApiError('O mapa foi atualizado. Volta a carregar o mapa.', 409);
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': currentMap.image.length, 'Cache-Control': 'no-store' });
        response.end(currentMap.image);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError('Rota não encontrada.', 404);
      let filename;
      if (pathname === '/' || pathname === '/index.html') filename = path.join(publicRoot, 'index.html');
      else if (pathname.startsWith('/assets/')) {
        const assetRoot = path.join(publicRoot, 'assets');
        filename = path.resolve(publicRoot, '.' + pathname);
        if (!filename.startsWith(assetRoot + path.sep) || pathname.split('/').some(part => part.startsWith('.'))) throw new ApiError('Ficheiro não encontrado.', 404);
      } else throw new ApiError('Rota não encontrada.', 404);
      const info = await fs.promises.stat(filename).catch(() => null);
      if (!info || !info.isFile()) throw new ApiError('Ficheiro não encontrado.', 404);
      response.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(filename).on('error', () => response.destroy()).pipe(response);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else send(response, error.status || 502, { ok: false, error: error.message || 'Não foi possível concluir o pedido.', partial: error.partial || false });
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;

  function tick() {
    if (closed) return;
    const currentMode = Date.now() - lastClient > 30000 ? 'sleep' : mode;
    const intervals = currentMode === 'active' ? { robot: 3000, hue: 2500, sync: 5000 } : currentMode === 'idle' ? { robot: 10000, hue: 5000, sync: 15000 } : { robot: 15000, hue: 10000, sync: 30000 };
    const activeRobot = state.robot.inCleaning > 0 || state.robot.inReturning > 0 ||
      ['vacuuming', 'mopping', 'vacuum_mop', 'returning', 'washing_mops', 'drying_mops', 'attaching_mops', 'detaching_mops', 'emptying_dust', 'mapping', 'patrol'].includes(state.robot.phase);
    if (activeRobot) intervals.robot = 3000;
    const operations = { robot: pollRobot, hue: pollLights, sync: pollSync, rooms: pollRooms, weather: pollWeather };
    for (const [name, operation] of Object.entries(operations)) {
      const interval = intervals[name] || (name === 'rooms' ? 300000 : 600000);
      if (!pending.has(name) && Date.now() - (polled[name] || 0) >= interval) operation().catch(() => {});
    }
    tickTimer = setTimeout(tick, 1000);
  }

  function start() {
    home.watchHue(event => {
      if (event.type === 'presence') { observePresence(event); return; }
      emit(event);
      if (event.type !== 'button') return;
      pollLights().catch(() => {});
      if (state.sync.active === true && state.connections.sync.online) {
        changeSync(false).catch(() => {});
      }
    });
    heartbeat = setInterval(() => {
      for (const response of clients) response.write(': heartbeat\n\n');
    }, 20000);
    if (heartbeat.unref) heartbeat.unref();
    tick();
  }

  async function close() {
    closed = true;
    clearTimeout(tickTimer);
    clearInterval(heartbeat);
    jobs.close();
    home.close();
    for (const response of clients) response.end();
    clients.clear();
    await robot.close();
    await new Promise(resolve => server.close(resolve));
  }

  return { server, state, jobs, start, close, snapshot, refresh: { robot: pollRobot, lights: pollLights, sync: pollSync, rooms: pollRooms, weather: pollWeather } };
}

if (require.main === module) {
  const { frameAdminAddress, startConfiguredFrameAdmin } = require('./frame-admin-server');
  const frameAdminDirectory = path.join(__dirname, 'data');
  const app = createApp(loadConfig(), { frameAdminAddress: () => frameAdminAddress(frameAdminDirectory) });
  const port = Number(process.env.PORT || 3000);
  let frameAdmin = null;
  app.server.listen(port, '127.0.0.1', () => {
    const panelPort = app.server.address().port;
    console.log(`Eddy disponível em http://127.0.0.1:${panelPort}`);
    app.start();
    frameAdmin = startConfiguredFrameAdmin({ dataDirectory: frameAdminDirectory, panelPort });
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const closeAdmin = frameAdmin ? new Promise(resolve => {
      frameAdmin.close(resolve);
      frameAdmin.closeAllConnections();
    }) : Promise.resolve();
    Promise.all([app.close(), closeAdmin]).then(() => process.exit(0)).catch(() => process.exit(1));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp, loadConfig };
