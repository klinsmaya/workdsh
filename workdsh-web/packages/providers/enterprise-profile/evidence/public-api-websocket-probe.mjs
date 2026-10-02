// Reproduction of the read-only public API probe. Run from workdsh-web.
// This test uses fixture browser authentication and a real loopback socket.
// It is not an enterprise authentication or target desktop acceptance test.
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';

const folders = await readdir('node_modules/.pnpm');
function packageRoot(name) {
  const folder = folders.find(value => value.startsWith('@deepseek-ai+' + name + '@'));
  assert.ok(folder, 'The pinned published package ' + name + ' must be installed.');
  return process.cwd() + '/node_modules/.pnpm/' + folder + '/node_modules/@deepseek-ai/' + name;
}
async function published(name) { return import(pathToFileURL(packageRoot(name) + '/lib/index.js').href); }
const { TypertRegistry } = await published('dsh-typert-registry');
const { TypertGatewayService } = await published('dsh-api-gateway');
const { HostConnectionService } = await published('dsh-client-connection');
const { WebServer } = await published('dsh-host-webserver');
const require = createRequire(packageRoot('dsh-api-gateway') + '/package.json');
const WebSocket = require('ws');
const ctx = new Context();
let middlewareCalls = 0;
let websocket;
try {
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  new HostConnectionService(ctx, [], { isAuthenticated() { return true; } });
  await ctx.plugin(TypertRegistry);
  await ctx.plugin(TypertGatewayService);
  ctx.on('connection/request', async () => { middlewareCalls++; throw Error('HTTP denied'); });
  websocket = new WebSocket('ws://127.0.0.1:' + ctx.webServer.port + '/api/remote.mux');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('probe timeout')), 4000);
    websocket.once('open', () => { clearTimeout(timeout); resolve(); });
    websocket.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  assert.equal(middlewareCalls, 0);
  console.log(JSON.stringify({ probe: 'actual localhost Gateway WebSocket upgrade with HTTP connection/request deny listener', upgrade: 'OPEN', middlewareCalls, result: 'BYPASS_CONFIRMED', scope: 'fixture BrowserAuth allows test; not enterprise authentication acceptance' }));
  await new Promise(resolve => { websocket.once('close', resolve); websocket.close(); });
} finally {
  websocket?.terminate();
  await ctx.fiber.dispose();
}
