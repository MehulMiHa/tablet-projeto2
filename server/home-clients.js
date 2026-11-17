'use strict';

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { hueLight } = require('./normalize');
const { discoverServices } = require('./discovery');

function serviceUrl(host, secure = false) {
  const url = new URL(host.includes('://') ? host : `${secure ? 'https' : 'http'}://${host}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Endereço de serviço inválido.');
  return url;
}

function pinnedAgent(config) {
  if (!config.fingerprint256) return undefined;
  const expected = config.fingerprint256.replaceAll(':', '').toLowerCase();
  const agent = new https.Agent({ keepAlive: true, maxSockets: 2 });
  agent.createConnection = (options, callback) => {
    let completed = false;
    const finish = (error, socket) => {
      if (completed) return;
      completed = true;
      callback(error, socket);
    };
    const socket = tls.connect({ ...options, rejectUnauthorized: false }, () => {
      const fingerprint = (socket.getPeerCertificate().fingerprint256 || '').replaceAll(':', '').toLowerCase();
      if (fingerprint !== expected) {
        const error = new Error('O certificado do dispositivo mudou.');
        socket.destroy(error);
        finish(error);
      } else finish(null, socket);
    });
    socket.once('error', error => finish(error));
  };
  return agent;
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const headers = { Accept: 'application/json', ...options.headers };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const request = transport.request(url, { method: options.method || 'GET', headers, agent: options.agent }, response => {
      let output = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        output += chunk;
        if (output.length > 2 * 1024 * 1024) request.destroy(new Error('Resposta demasiado grande.'));
      });
      response.on('end', () => {
        clearTimeout(timer);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`O dispositivo recusou o pedido (${response.statusCode}).`));
          return;
        }
        try { resolve(JSON.parse(output)); } catch { reject(new Error('O dispositivo devolveu uma resposta inválida.')); }
      });
      response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new Error('O dispositivo não respondeu a tempo.')), options.timeout || 5000);
    request.on('error', error => { clearTimeout(timer); reject(error); });
    if (body) request.write(body);
    request.end();
  });
}

class HomeClients {
  constructor(config) {
    this.config = config;
    this.syncAgent = config.sync ? pinnedAgent(config.sync) : undefined;
    this.hueAgent = config.hue ? pinnedAgent(config.hue) : undefined;
    this.writeQueue = Promise.resolve();
    this.eventsRequest = null;
    this.eventsTimer = null;
    this.closed = false;
    this.discovery = new Map();
    this.lastDiscovery = {};
  }

  hueUrl(resource, secure = false) {
    const hue = this.config.hue || {};
    if (!hue.host || !hue.token) throw new Error('Falta configurar as luzes Hue.');
    return new URL(`/api/${hue.token}/${resource}`, serviceUrl(hue.host, secure));
  }

  async lights() {
    try { return await this.readLights(); }
    catch (error) {
      if (await this.rediscover('hue')) return this.readLights();
      throw error;
    }
  }

  async readLights() {
    const hue = this.config.hue || {};
    const stripGroup = hue.groups && hue.groups.sanca || '82';
    const [lights, strip] = await Promise.all([
      requestJson(this.hueUrl('lights')),
      requestJson(this.hueUrl(`groups/${stripGroup}`))
    ]);
    if (Array.isArray(lights) || !strip.action) throw new Error('A Bridge Hue não confirmou o estado das luzes.');
    const stripState = { ...strip.action };
    if (strip.state && typeof strip.state.any_on === 'boolean') stripState.on = strip.state.any_on;
    stripState.reachable = (strip.lights || []).some(id => lights[id] && lights[id].state && lights[id].state.reachable !== false);
    const items = [hueLight('sanca', stripState)];
    for (const [id, bridgeId] of Object.entries(hue.lights || {})) {
      if (!lights[bridgeId] || !lights[bridgeId].state) throw new Error(`A Bridge não encontrou ${id}.`);
      items.push(hueLight(id, lights[bridgeId].state));
    }
    return { items, updatedAt: Date.now() };
  }

  async syncState() {
    try { return await this.readSyncState(); }
    catch (error) {
      if (await this.rediscover('sync')) return this.readSyncState();
      throw error;
    }
  }

  async readSyncState() {
    const config = this.config.sync || {};
    if (!config.host || !config.token) throw new Error('Falta configurar a sincronização TV.');
    const data = await requestJson(new URL('/api/v1/execution', serviceUrl(config.host, true)), {
      headers: { Authorization: `Bearer ${config.token}` }, agent: this.syncAgent
    });
    if (typeof data.syncActive !== 'boolean') throw new Error('A Sync Box não confirmou o estado.');
    return { active: data.syncActive };
  }

  async setSync(active) {
    const config = this.config.sync || {};
    if (!config.host || !config.token) throw new Error('Falta configurar a sincronização TV.');
    await requestJson(new URL('/api/v1/execution', serviceUrl(config.host, true)), {
      method: 'PUT', body: { syncActive: active },
      headers: { Authorization: `Bearer ${config.token}` }, agent: this.syncAgent
    });
    return this.syncState();
  }

  controlLights(ids, values) {
    const operation = this.writeQueue.then(() => this.writeLights(ids, values));
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async writeLights(ids, values) {
    const hue = this.config.hue || {};
    const body = {};
    if (values.on !== undefined) body.on = values.on;
    if (values.brightness !== undefined) {
      body.bri = Math.max(1, Math.round(values.brightness * 254 / 100));
      if (body.on === undefined) body.on = true;
    }
    if (values.temperature !== undefined) {
      body.ct = Math.max(153, Math.min(500, Math.round(1000000 / values.temperature)));
      if (body.on === undefined) body.on = true;
    }
    const warnings = [];
    if (this.config.sync && this.config.sync.host) {
      try {
        const sync = await this.syncState();
        if (sync.active) await this.setSync(false);
      } catch {
        warnings.push('A Sync Box não confirmou a interrupção da sincronização TV.');
      }
    }
    const spots = Object.keys(hue.lights || {});
    const hasStrip = ids.includes('sanca');
    const allSpots = spots.length > 0 && spots.every(id => ids.includes(id));
    const groups = { sanca: '82', all: '83', focos: '84', ...(hue.groups || {}) };
    let resources;
    if (hasStrip && allSpots && ids.length === spots.length + 1) resources = [`groups/${groups.all}/action`];
    else if (!hasStrip && allSpots && ids.length === spots.length) resources = [`groups/${groups.focos}/action`];
    else resources = ids.map(id => id === 'sanca' ? `groups/${groups.sanca}/action` : `lights/${hue.lights[id]}/state`);
    const applied = [];
    for (const resource of resources) {
      const result = await requestJson(this.hueUrl(resource), { method: 'PUT', body });
      if (!Array.isArray(result) || result.some(item => item.error) || !result.some(item => item.success)) {
        const error = new Error('A Bridge Hue não confirmou todas as alterações.');
        error.partial = applied.length > 0;
        throw error;
      }
      applied.push(resource);
    }
    return { ...await this.lights(), warnings };
  }

  async rediscover(name) {
    if (this.discovery.has(name)) return this.discovery.get(name);
    if (Date.now() - (this.lastDiscovery[name] || 0) < 60000) return false;
    const config = this.config[name] || {};
    if (!config.token || !config.fingerprint256) return false;
    this.lastDiscovery[name] = Date.now();
    const operation = this.findDevice(name, config).catch(() => false).finally(() => this.discovery.delete(name));
    this.discovery.set(name, operation);
    return operation;
  }

  async findDevice(name, config) {
    const service = name === 'hue' ? '_hue._tcp.local' : '_huesync._tcp.local';
    const devices = await discoverServices(service, { timeoutMs: 2500 });
    if (name === 'hue' && config.bridgeId) {
      try {
        const advertised = await requestJson(new URL('https://discovery.meethue.com'), { timeout: 4000 });
        for (const item of advertised) {
          if (String(item.id).toLowerCase() === String(config.bridgeId).toLowerCase()) devices.push({ host: item.internalipaddress });
        }
      } catch { /* Local discovery can succeed while internet is unavailable. */ }
    }
    const hosts = [...new Set(devices.map(device => device.host).filter(Boolean))].slice(0, 8);
    for (const host of hosts) {
      try {
        const url = new URL(name === 'hue' ? `/api/${config.token}/config` : '/api/v1/device', serviceUrl(host, true));
        const identity = await requestJson(url, {
          agent: name === 'hue' ? this.hueAgent : this.syncAgent,
          headers: name === 'sync' ? { Authorization: `Bearer ${config.token}` } : {}, timeout: 2500
        });
        const received = name === 'hue' ? identity.bridgeid : identity.uniqueId;
        const expected = name === 'hue' ? config.bridgeId : config.uniqueId;
        if (expected && String(received).toLowerCase() !== String(expected).toLowerCase()) continue;
        if (name === 'hue' && !identity.bridgeid) continue;
        if (name === 'sync' && !identity.uniqueId) continue;
        config.host = host;
        if (name === 'hue' && this.eventsRequest) this.eventsRequest.destroy();
        return true;
      } catch { /* Only an authenticated, certificate-matched device is adopted. */ }
    }
    return false;
  }

  watchHue(callback) {
    const hue = this.config.hue || {};
    if (!hue.host || !hue.token || !hue.fingerprint256) return;
    const connect = () => {
      if (this.closed) return;
      const url = new URL('/eventstream/clip/v2', serviceUrl(hue.host, true));
      const request = https.get(url, {
        agent: this.hueAgent, headers: { 'hue-application-key': hue.token, Accept: 'text/event-stream' }
      }, response => {
        if (response.statusCode !== 200) { response.resume(); request.destroy(); return; }
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          buffer += chunk.replaceAll('\r', '');
          if (buffer.length > 262144) { request.destroy(); return; }
          let separator = buffer.indexOf('\n\n');
          while (separator !== -1) {
            const event = buffer.slice(0, separator).replaceAll('\r', '');
            buffer = buffer.slice(separator + 2);
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            if (data) {
              try {
                for (const envelope of JSON.parse(data)) {
                  for (const item of envelope.data || []) {
                    if (item.type === 'motion' && item.motion && typeof item.motion.motion === 'boolean') {
                      callback({ type: 'motion', id: item.id, motion: item.motion.motion, active: item.motion.motion });
                    }
                    const mapping = (hue.buttons || {})[item.id];
                    if (item.type === 'button' && item.button && item.button.last_event === 'initial_press' && mapping) {
                      callback({ type: 'button', id: item.id, ids: Array.isArray(mapping) ? mapping : mapping.ids || [], group: mapping.group || null });
                    }
                  }
                }
              } catch { /* A malformed event is discarded without growing the buffer. */ }
            }
            separator = buffer.indexOf('\n\n');
          }
        });
        response.on('end', () => request.destroy());
      });
      this.eventsRequest = request;
      request.setTimeout(90000, () => request.destroy());
      request.once('close', () => {
        if (!this.closed) this.eventsTimer = setTimeout(connect, 5000);
      });
      request.on('error', () => {});
    };
    connect();
  }

  async weather() {
    const config = this.config.weather || {};
    const result = { outdoorTemperature: null, indoorTemperature: null, rainProbability: null, updatedAt: Date.now() };
    const latitude = config.latitude === undefined ? config.lat : config.latitude;
    const longitude = config.longitude === undefined ? config.lon : config.longitude;
    if (config.apiKey && latitude !== undefined && longitude !== undefined) {
      const query = new URLSearchParams({ lat: latitude, lon: longitude, appid: config.apiKey, units: 'metric' });
      const [current, forecast] = await Promise.all([
        requestJson(new URL(`https://api.openweathermap.org/data/2.5/weather?${query}`)),
        requestJson(new URL(`https://api.openweathermap.org/data/2.5/forecast?${query}`))
      ]);
      result.outdoorTemperature = typeof current.main?.temp === 'number' ? current.main.temp : null;
      const probabilities = (forecast.list || []).slice(0, 4).map(item => item.pop).filter(value => typeof value === 'number');
      if (probabilities.length) result.rainProbability = Math.round(Math.max(...probabilities) * 100);
    }
    if (config.indoorSensorId) {
      const sensor = await requestJson(this.hueUrl(`sensors/${config.indoorSensorId}`));
      if (typeof sensor.state?.temperature === 'number') result.indoorTemperature = sensor.state.temperature / 100;
    }
    return result;
  }

  close() {
    this.closed = true;
    clearTimeout(this.eventsTimer);
    if (this.eventsRequest) this.eventsRequest.destroy();
    if (this.syncAgent) this.syncAgent.destroy();
    if (this.hueAgent) this.hueAgent.destroy();
  }
}

module.exports = { HomeClients, requestJson, pinnedAgent };
