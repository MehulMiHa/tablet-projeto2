'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createFrameAdminServer } = require('./frame-admin-server');

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
