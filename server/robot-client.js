'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

class RobotClient {
  constructor(config, options = {}) {
    this.config = config || {};
    this.spawn = options.spawn || spawn;
    this.child = null;
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = '';
    this.queue = Promise.resolve();
    this.closed = false;
    this.lastFailure = 0;
  }

  start() {
    if (this.closed) throw new Error('A ligação ao Rocky foi encerrada.');
    if (!this.config.deviceId) throw new Error('Falta configurar o aspirador.');
    if (this.child) return;
    if (Date.now() - this.lastFailure < 1000) throw new Error('A restabelecer a ligação ao Rocky.');
    const prefix = this.config.prefix || '/data/data/com.termux/files/usr';
    const home = this.config.home || os.homedir();
    const environment = { ...process.env, HOME: home, EDDY_DEVICE_ID: this.config.deviceId };
    if (process.platform !== 'win32') {
      environment.PREFIX = prefix;
      environment.PATH = `${prefix}/bin:${process.env.PATH || '/system/bin'}`;
      environment.TMPDIR = `${prefix}/tmp`;
      environment.LD_LIBRARY_PATH = `${prefix}/lib`;
    }
    const child = this.spawn(this.config.pythonPath || 'python3', [path.join(__dirname, 'robot-worker.py')], {
      env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.receive(chunk));
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.failed(child, new Error('A ligação ao Rocky foi interrompida.')));
    child.on('error', () => this.failed(child, new Error('Não foi possível iniciar a ligação ao Rocky.')));
    child.on('exit', () => this.failed(child, new Error('A ligação ao Rocky foi interrompida.')));
  }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.failed(this.child, new Error('A resposta do mapa excedeu o tamanho permitido.'));
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let response;
      try { response = JSON.parse(line); } catch {
        this.failed(this.child, new Error('A ligação ao Rocky devolveu uma resposta inválida.'));
        return;
      }
      const request = this.pending.get(response.id);
      if (request) {
        this.pending.delete(response.id);
        clearTimeout(request.timer);
        if (response.ok) request.resolve(response.result);
        else request.reject(new Error(response.error || 'O Rocky não confirmou o pedido.'));
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  failed(child, error) {
    if (!child || this.child !== child) return;
    this.child = null;
    this.lastFailure = Date.now();
    this.buffer = '';
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    child.kill();
  }

  call(method, payload = {}, timeout = 42000) {
    const operation = this.queue.then(() => this.request(method, payload, timeout));
    this.queue = operation.catch(() => {});
    return operation;
  }

  request(method, payload, timeout) {
    this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.failed(this.child, new Error('O Saros não respondeu a tempo.')), timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, ...payload }) + '\n');
    });
  }

  async close() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    this.failed(child, new Error('A ligação ao Rocky foi encerrada.'));
  }
}

module.exports = { RobotClient };
