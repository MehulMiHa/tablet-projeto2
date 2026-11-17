'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function requestId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new ApiError('O pedido precisa de um identificador válido.');
  return value;
}

function roomIds(values, available) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 100) throw new ApiError('Seleção de divisões inválida.');
  const ids = [...new Set(values)];
  if (ids.some(id => !Number.isInteger(id) || !available.includes(id))) throw new ApiError('Uma das divisões já não existe no mapa atual. Atualiza o mapa.');
  return ids.sort((a, b) => a - b);
}

function validateClean(body, rooms) {
  const available = rooms.map(room => room.id);
  const vacuumRooms = roomIds(body.vacuumRooms, available);
  const mopRooms = roomIds(body.mopRooms, available);
  const zones = body.zones || [];
  if (!Array.isArray(zones) || zones.length > 10) throw new ApiError('Seleção de zonas inválida.');
  for (const zone of zones) {
    if (!Array.isArray(zone) || zone.length !== 5 || zone.some(value => !Number.isFinite(value) || !Number.isInteger(value))) throw new ApiError('As coordenadas da zona são inválidas.');
    if (zone[0] < 0 || zone[1] < 0 || zone[2] > 100000 || zone[3] > 100000 || zone[2] <= zone[0] || zone[3] <= zone[1] || zone[4] !== 1) throw new ApiError('A zona fica fora dos limites do mapa.');
  }
  if (zones.length && (vacuumRooms.length || mopRooms.length)) throw new ApiError('Escolhe divisões ou uma zona para esta limpeza.');
  if (!zones.length && !vacuumRooms.length && !mopRooms.length) throw new ApiError('Escolhe pelo menos uma divisão ou uma zona.');
  if (zones.length && !['vacuum', 'mop', 'vacuum_mop'].includes(body.zoneMode)) throw new ApiError('Escolhe o modo de limpeza da zona.');
  if (!Number.isInteger(body.suction) || body.suction < 101 || body.suction > 104) throw new ApiError('Escolhe uma potência de sucção válida.');
  if (!Number.isInteger(body.water) || body.water < 1 || body.water > 30) throw new ApiError('Escolhe uma quantidade de água entre 1 e 30.');
  return { requestId: requestId(body.requestId), vacuumRooms, mopRooms, zones, zoneMode: zones.length ? body.zoneMode : null, suction: body.suction, water: body.water };
}

const ACTIVE_STATES = [5, 11, 17, 18, 6301, 6302, 6303, 6304, 6305, 6306, 6307, 6308, 6309];
const BUSY_STATES = [1, 4, 5, 6, 7, 10, 11, 14, 15, 16, 17, 18, 22, 23, 25, 26, 28, 29, 30, 32, 33, 34, 202, 6301, 6302, 6303, 6304, 6305, 6306, 6307, 6308, 6309, 6310];
const FINISHED_STATES = [8, 100];
const TERMINAL_JOBS = ['completed', 'failed', 'cancelled', 'interrupted'];

class Jobs {
  constructor({ robot, getStatus, getRooms, onChange = () => {}, stateFile = null, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollMs = 3000 }) {
    this.robot = robot;
    this.getStatus = getStatus;
    this.getRooms = getRooms;
    this.onChange = onChange;
    this.stateFile = stateFile;
    this.now = now;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.current = null;
    this.receipts = new Map();
    this.generation = 0;
    this.timer = null;
    this.timerVersion = 0;
    this.paused = false;
    this.closed = false;
    this.load();
  }

  load() {
    if (!this.stateFile) return;
    try {
      const stored = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.current = stored.current || null;
      this.receipts = new Map((stored.receipts || []).slice(-256));
      if (this.current && !TERMINAL_JOBS.includes(this.current.status)) {
        this.current.status = 'interrupted';
        this.current.message = 'O serviço reiniciou. Verifica o estado real do Rocky antes de continuar.';
        this.current.resumeAt = null;
        this.current.updatedAt = this.now();
        this.persist();
      }
    } catch { /* A first run has no saved job. */ }
  }

  persist() {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = this.stateFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ current: this.current, receipts: [...this.receipts] }));
    fs.renameSync(temporary, this.stateFile);
  }

  receipt(id, signature) {
    const previous = this.receipts.get(id);
    if (!previous) return null;
    if (previous.signature !== signature) throw new ApiError('Este identificador já foi usado para um pedido diferente.', 409);
    return previous.result;
  }

  remember(id, signature, result) {
    this.receipts.set(id, { signature, result });
    while (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value);
    this.persist();
    return result;
  }

  changed(values) {
    if (this.current) Object.assign(this.current, values, { updatedAt: this.now() });
    this.persist();
    this.onChange(this.snapshot());
  }

  snapshot() {
    return this.current ? JSON.parse(JSON.stringify(this.current)) : null;
  }

  cancelTimer() {
    clearTimeout(this.timer);
    this.timer = null;
    this.timerVersion++;
    if (this.current) this.current.resumeAt = null;
  }

  assertCurrent(generation) {
    if (this.closed || generation !== this.generation) throw new ApiError('Limpeza cancelada.', 409);
  }

  async send(command, params, generation) {
    await this.waitWhilePaused(generation);
    this.assertCurrent(generation);
    return this.robot.call('command', { command, params });
  }

  async waitWhilePaused(generation) {
    this.assertCurrent(generation);
    while (this.paused) {
      await this.sleep(500);
      this.assertCurrent(generation);
    }
  }

  start(body) {
    const clean = validateClean(body, this.getRooms());
    const signature = JSON.stringify(clean);
    const repeated = this.receipt(clean.requestId, signature);
    if (repeated) return this.current && this.current.id === repeated.jobId ? { ...repeated, status: this.current.status } : repeated;
    const status = this.getStatus(false);
    if (!status || !status.online) throw new ApiError('O Rocky está sem ligação. Aguarda pela atualização do estado.', 503);
    if (this.current && !TERMINAL_JOBS.includes(this.current.status)) throw new ApiError('Já existe uma limpeza em curso. Podes pausá-la ou regressar à base.', 409);
    if (BUSY_STATES.includes(status.stateCode)) throw new ApiError('O Rocky já está ocupado. Verifica o estado atual antes de iniciar outra limpeza.', 409);
    if (status.errorCode) throw new ApiError('Resolve o aviso do Rocky antes de iniciar a limpeza.', 409);
    this.cancelTimer();
    this.paused = false;
    const generation = ++this.generation;
    this.current = {
      id: crypto.randomUUID(), status: 'accepted', phase: 'preparing',
      message: 'A preparar a limpeza', createdAt: this.now(), updatedAt: this.now(),
      resumeAt: null, error: null, startCommandSent: false
    };
    const result = this.remember(clean.requestId, signature, { ok: true, jobId: this.current.id, status: 'accepted' });
    this.onChange(this.snapshot());
    Promise.resolve().then(() => this.run(clean, generation)).catch(error => {
      if (generation !== this.generation || this.closed) return;
      this.changed({ status: 'failed', phase: 'error', error: error.message, message: error.message });
    });
    return result;
  }

  async run(clean, generation) {
    const phases = [];
    if (clean.vacuumRooms.length) phases.push({ mode: 'vacuum', rooms: clean.vacuumRooms });
    if (clean.mopRooms.length) phases.push({ mode: 'mop', rooms: clean.mopRooms });
    if (clean.zones.length) {
      if (clean.zoneMode !== 'mop') phases.push({ mode: 'vacuum', zones: clean.zones });
      if (clean.zoneMode !== 'vacuum') phases.push({ mode: 'mop', zones: clean.zones });
    }
    for (const [index, phase] of phases.entries()) {
      await this.waitWhilePaused(generation);
      this.assertCurrent(generation);
      this.changed({ status: 'preparing', phase: phase.mode, startCommandSent: false, message: phase.mode === 'vacuum' ? 'A preparar a aspiração' : 'A preparar a lavagem' });
      let status = await this.getStatus(true);
      this.assertCurrent(generation);
      if (this.paused) {
        await this.waitWhilePaused(generation);
        status = await this.getStatus(true);
      }
      if (!status || !status.online) throw new Error('O Rocky está sem ligação.');
      if (index === 0 && BUSY_STATES.includes(status.stateCode)) throw new Error('O Rocky ficou ocupado entretanto. Verifica o estado antes de iniciar outra limpeza.');
      if (status.errorCode) throw new Error('Resolve o aviso do Rocky antes de continuar a limpeza.');
      await this.send('set_custom_clean_mode', [0], generation);
      await this.send('set_mop_mode', [300], generation);
      await this.send('set_water_box_custom_mode', [phase.mode === 'vacuum' ? 200 : 204], generation);
      await this.send('set_custom_mode', [phase.mode === 'vacuum' ? clean.suction : 105], generation);
      if (phase.mode === 'mop') await this.send('set_custom_water_level', [clean.water], generation);
      const command = phase.zones ? 'app_zoned_clean' : 'app_segment_clean';
      const params = phase.zones || [{ segments: phase.rooms, repeat: 1 }];
      await this.waitWhilePaused(generation);
      this.assertCurrent(generation);
      this.changed({ startCommandSent: true });
      await this.robot.call('command', { command, params });
      this.assertCurrent(generation);
      this.changed({ status: 'starting', phase: phase.mode, message: 'A aguardar confirmação do Rocky' });
      await this.waitForCompletion(generation, phase.mode);
    }
    this.assertCurrent(generation);
    this.changed({ status: 'completed', phase: 'completed', message: 'Limpeza concluída' });
  }

  async waitForCompletion(generation, phase) {
    const started = this.now();
    let observedRunning = false;
    while (this.now() - started < 4 * 60 * 60 * 1000) {
      this.assertCurrent(generation);
      const status = await this.getStatus(true);
      this.assertCurrent(generation);
      if (!status || !status.online) throw new Error('A ligação ao Rocky foi interrompida. Verifica o estado real antes de continuar.');
      if (status.errorCode || status.stateCode === 12) throw new Error('O Rocky precisa de ajuda para continuar a limpeza.');
      if (ACTIVE_STATES.includes(status.stateCode) || status.inCleaning > 0) {
        observedRunning = true;
        if (!this.paused && this.current.status !== 'running') this.changed({ status: 'running', phase, message: phase === 'vacuum' ? 'A aspirar' : 'A lavar o chão' });
      }
      if (observedRunning && FINISHED_STATES.includes(status.stateCode) && status.inCleaning === 0) return;
      if (!observedRunning && this.now() - started > 5 * 60 * 1000) throw new Error('O Rocky não confirmou o início da limpeza.');
      await this.sleep(this.pollMs);
    }
    throw new Error('A limpeza excedeu o tempo de acompanhamento. Verifica o estado do Rocky.');
  }

  async control(body) {
    const id = requestId(body.requestId);
    if (!['pause', 'resume', 'home', 'pause15'].includes(body.action)) throw new ApiError('Ação do Rocky inválida.');
    const signature = JSON.stringify({ action: body.action });
    const repeated = this.receipt(id, signature);
    if (repeated) return repeated;
    this.cancelTimer();
    const actionVersion = this.timerVersion;
    const localPreparation = this.current && !TERMINAL_JOBS.includes(this.current.status) && !this.current.trackingOnly && !this.current.startCommandSent;
    if (body.action === 'resume' && !localPreparation) {
      const status = await this.getStatus(true);
      if (actionVersion !== this.timerVersion) throw new ApiError('A ação foi substituída por outro pedido.', 409);
      if (!status || !status.online) throw new ApiError('O Rocky está sem ligação.', 503);
      if (status.stateCode !== 10) throw new ApiError('O Rocky já não está pausado. O estado foi atualizado.', 409);
    }
    if (body.action === 'home') {
      ++this.generation;
      this.paused = false;
      if (this.current && !TERMINAL_JOBS.includes(this.current.status)) this.changed({ status: 'cancelled', phase: 'returning', message: 'Regresso à base pedido' });
    }
    if (body.action === 'pause' || body.action === 'pause15') this.paused = true;
    if (body.action === 'resume') this.paused = false;
    const result = { ok: true, status: 'sending', action: body.action };
    this.remember(id, signature, result);
    const command = body.action === 'home' ? 'app_charge' : body.action === 'resume' ? 'app_start' : 'app_pause';
    try {
      if (!localPreparation || body.action === 'home') await this.robot.call('command', { command, params: [] });
      if (actionVersion !== this.timerVersion) {
        result.status = 'sent';
        return this.remember(id, signature, result);
      }
      if (this.current && !TERMINAL_JOBS.includes(this.current.status)) {
        this.changed({ status: this.paused ? 'paused' : localPreparation ? 'preparing' : 'starting', message: this.paused ? 'Limpeza em pausa' : 'Retoma pedida' });
      }
      if (body.action === 'pause15') {
        const version = this.timerVersion;
        const resumeAt = this.now() + 15 * 60 * 1000;
        if (!this.current || TERMINAL_JOBS.includes(this.current.status)) this.current = { id: crypto.randomUUID(), status: 'paused', phase: 'paused', createdAt: this.now(), trackingOnly: true };
        this.changed({ status: 'paused', resumeAt, message: 'Pausa de 15 minutos' });
        this.timer = setTimeout(() => this.resumeAfterPause(version).catch(() => {}), 15 * 60 * 1000);
        if (this.timer.unref) this.timer.unref();
      }
      result.status = 'sent';
      return this.remember(id, signature, result);
    } catch (error) {
      if (actionVersion === this.timerVersion) this.paused = false;
      this.remember(id, signature, { ok: false, status: 'failed', action: body.action, error: error.message });
      throw error;
    }
  }

  async resumeAfterPause(version) {
    if (this.closed || version !== this.timerVersion) return;
    try {
      if (this.current && !this.current.trackingOnly && !this.current.startCommandSent && !TERMINAL_JOBS.includes(this.current.status)) {
        this.paused = false;
        this.changed({ status: 'preparing', resumeAt: null, message: 'A retomar a preparação' });
        return;
      }
      const status = await this.getStatus(true);
      if (version !== this.timerVersion) return;
      if (!status || !status.online || status.stateCode !== 10) {
        this.paused = false;
        if (status && status.online && (ACTIVE_STATES.includes(status.stateCode) || status.inCleaning > 0)) {
          this.changed({ status: 'running', resumeAt: null, message: 'A limpeza já foi retomada' });
        } else {
          ++this.generation;
          this.changed({ status: 'interrupted', resumeAt: null, message: 'Retoma automática cancelada. Verifica o estado do Rocky.' });
        }
        return;
      }
      await this.robot.call('command', { command: 'app_start', params: [] });
      if (version !== this.timerVersion) return;
      this.paused = false;
      this.changed({ status: 'starting', resumeAt: null, message: 'Retoma pedida' });
    } catch (error) {
      this.changed({ resumeAt: null, error: error.message, message: 'Não foi possível retomar. Verifica a ligação ao Rocky.' });
    }
  }

  close() {
    this.closed = true;
    ++this.generation;
    this.cancelTimer();
  }

  observeStatus(status) {
    if (!this.current || !this.current.trackingOnly || TERMINAL_JOBS.includes(this.current.status)) return;
    if (status.online && FINISHED_STATES.includes(status.stateCode) && status.inCleaning === 0) {
      this.cancelTimer();
      this.paused = false;
      this.changed({ status: 'completed', phase: 'completed', message: 'O Rocky está na base' });
    }
  }
}

module.exports = { Jobs, ApiError, validateClean };
