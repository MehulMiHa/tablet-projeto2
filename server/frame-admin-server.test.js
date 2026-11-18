'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createFrameAdminServer, startFrameAdminListeners } = require('./frame-admin-server');

async function listen(testContext, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  testContext.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('phone access authenticates and forwards only photo requests with the expected headers', async context => {
  const forwarded = [];
  const panelPort = await listen(context, http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    forwarded.push({
      method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString()
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  }));
  const login = 'eddy:test-password';
  const passwordHash = createHash('sha256').update(login).digest('hex');
  const port = await listen(context, createFrameAdminServer({ config: { passwordHash, address: '100.64.12.34' }, panelPort }));
  const origin = `http://127.0.0.1:${port}`;
  const auth = `Basic ${Buffer.from(login).toString('base64')}`;
  const noLogin = await fetch(origin + '/api/frame');
  assert.equal(noLogin.status, 401);
  assert.match(noLogin.headers.get('www-authenticate'), /Basic/);
  const assets = await fetch(origin + '/', { headers: { authorization: auth } });
  assert.equal(assets.status, 200);
  assert.match(await assets.text(), /frame-admin\.js/);

  for (const [method, url] of [
    ['GET', '/api/state'], ['GET', '/api/events'], ['POST', '/api/lights/control'],
    ['POST', '/api/robot/control'], ['PUT', '/api/frame/settings'], ['GET', '/api/frame?debug=1']
  ]) {
    const result = await fetch(origin + url, { method, headers: { authorization: auth, origin } });
    assert.equal(result.status, 404, `${method} ${url}`);
  }
  const crossSite = await fetch(origin + '/api/frame/photos', {
    method: 'POST', headers: { authorization: auth, origin: 'http://example.org', 'content-type': 'image/jpeg' }, body: 'fixture'
  });
  assert.equal(crossSite.status, 403);
  assert.equal(forwarded.length, 0);

  const image = await fetch(origin + '/api/frame/photos', {
    method: 'POST', headers: { authorization: auth, origin, 'content-type': 'image/jpeg', 'x-photo-name': 'Teste.jpg' }, body: 'fixture'
  });
  assert.equal(image.status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].url, '/api/frame/photos');
  assert.equal(forwarded[0].body, 'fixture');
  assert.equal(forwarded[0].headers['x-photo-name'], 'Teste.jpg');
  assert.equal(forwarded[0].headers.origin, undefined);
  assert.equal(forwarded[0].headers.authorization, undefined);
});

test('repeated wrong passwords temporarily stop authentication checks without extending the cooldown', async context => {
  let timestamp = 1000;
  const login = 'eddy:correct-password';
  const passwordHash = createHash('sha256').update(login).digest('hex');
  const port = await listen(context, createFrameAdminServer({ config: { passwordHash }, now: () => timestamp }));
  const origin = `http://127.0.0.1:${port}`;
  const authorize = value => ({ authorization: `Basic ${Buffer.from(value).toString('base64')}` });
  const session = headers => fetch(origin + '/api/session', { headers });

  // Browsers request the initial authentication challenge before supplying a password.
  for (let attempt = 0; attempt < 20; attempt++) assert.equal((await session()).status, 401);
  assert.equal((await session(authorize(login))).status, 200);
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal((await session(authorize(`eddy:wrong-${attempt}`))).status, 401);
  }
  const blocked = await session(authorize('eddy:another-guess'));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '30');
  // Check the limit before comparing a password: guessing must not retain a success oracle.
  assert.equal((await session(authorize(login))).status, 429);
  timestamp += 29000;
  const almostExpired = await session(authorize('eddy:still-wrong'));
  assert.equal(almostExpired.status, 429);
  assert.equal(almostExpired.headers.get('retry-after'), '1');
  timestamp += 1000;
  const recovered = await session(authorize(login));
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { role: 'owner' });
});

test('the loopback and private listeners share the authentication attempt limit', async context => {
  const passwordHash = createHash('sha256').update('eddy:correct').digest('hex');
  const authState = { failures: 0, windowEnd: 0 };
  const options = { config: { passwordHash }, authState };
  const ports = await Promise.all([listen(context, createFrameAdminServer(options)), listen(context, createFrameAdminServer(options))]);
  const attempt = (port, login) => fetch(`http://127.0.0.1:${port}/api/session`, {
    headers: { authorization: `Basic ${Buffer.from(login).toString('base64')}` }
  });
  for (let count = 0; count < 20; count++) assert.equal((await attempt(ports[count % 2], `eddy:wrong-${count}`)).status, 401);
  for (const port of ports) assert.equal((await attempt(port, 'eddy:correct')).status, 429);
});

function listenerHarness() {
  const servers = [];
  const timers = [];
  const attempts = [];
  let vpnAvailable = false;
  class Listener extends EventEmitter {
    listen(port, host) {
      attempts.push({ port, host });
      this.host = host;
      if (host !== '127.0.0.1' && !vpnAvailable) queueMicrotask(() => this.emit('error', { code: 'EADDRNOTAVAIL' }));
      else this.listening = true;
    }
    close(callback) { this.listening = false; this.closed = true; queueMicrotask(callback); }
    closeAllConnections() { this.connectionsClosed = true; }
  }
  return {
    servers, timers, attempts,
    makeVpnAvailable() { vpnAvailable = true; },
    dependencies: {
      createServer(options) { const server = new Listener(); server.options = options; servers.push(server); return server; },
      schedule(run, delay) { const timer = { run, delay, unref() { this.unreferenced = true; } }; timers.push(timer); return timer; },
      cancel(timer) { timer.cancelled = true; },
      reportError(error) { throw new Error(`Unexpected listener error: ${error.code}`); }
    }
  };
}

test('private gateway waits for the VPN address while retaining loopback access and closes both listeners', async () => {
  const harness = listenerHarness();
  const controller = startFrameAdminListeners({ config: { address: '100.99.231.9' } }, harness.dependencies);
  await new Promise(setImmediate);
  assert.deepEqual(harness.attempts, [{ port: 8787, host: '127.0.0.1' }, { port: 8787, host: '100.99.231.9' }]);
  assert.equal(harness.servers[0].listening, true);
  assert.equal(harness.servers[1].listening, undefined);
  assert.equal(harness.servers[0].options.authState, harness.servers[1].options.authState);
  assert.equal(harness.timers[0].delay, 2000);
  assert.equal(harness.timers[0].unreferenced, true);
  harness.makeVpnAvailable();
  harness.timers[0].run();
  assert.equal(harness.servers[1].listening, true);
  await new Promise(resolve => { controller.close(resolve); controller.closeAllConnections(); });
  assert.ok(harness.servers.every(server => server.closed && server.connectionsClosed));
});

test('closing a gateway waiting for the VPN cancels retries and cannot reopen a listener', async () => {
  const harness = listenerHarness();
  const controller = startFrameAdminListeners({ config: { address: '100.99.231.9' } }, harness.dependencies);
  await new Promise(setImmediate);
  await new Promise(resolve => controller.close(resolve));
  assert.equal(harness.timers[0].cancelled, true);
  harness.makeVpnAvailable();
  harness.timers[0].run();
  assert.equal(harness.attempts.length, 2);
  assert.ok(harness.servers.every(server => server.closed && !server.listening));
  assert.throws(() => startFrameAdminListeners({ config: { address: '0.0.0.0' } }, harness.dependencies), /Tailscale/);
});
