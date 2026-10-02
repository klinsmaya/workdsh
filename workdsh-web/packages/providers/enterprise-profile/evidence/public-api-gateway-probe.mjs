// Reproduction of the read-only public API probe. Run from workdsh-web.
// Fixture output is evidence only; it does not establish an AFOS AT PASS.
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';

const folders = await readdir('node_modules/.pnpm');
async function published(name) {
  const folder = folders.find(value => value.startsWith('@deepseek-ai+' + name + '@'));
  assert.ok(folder, 'The pinned published package ' + name + ' must be installed.');
  return import(pathToFileURL(process.cwd() + '/node_modules/.pnpm/' + folder + '/node_modules/@deepseek-ai/' + name + '/lib/index.js').href);
}
const { TypertRegistry } = await published('dsh-typert-registry');
const { TypertGatewayService } = await published('dsh-api-gateway');
const readInitializers = [];
const streamInitializers = [];
let effects = 0;
let middlewareCalls = 0;
class BoundaryProbe extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'afosProbe');
    for (const initialize of [...readInitializers, ...streamInitializers]) initialize.call(this);
  }
  async read() { effects++; return { kind: 'read' }; }
  async *watch() { effects++; yield { kind: 'stream' }; }
}
const decoratorContext = (name, initializers) => ({ kind: 'method', name, static: false, private: false, addInitializer(initialize) { initializers.push(initialize); } });
Remote(BoundaryProbe.prototype.read, decoratorContext('read', readInitializers));
Remote({ mode: 'stream' })(BoundaryProbe.prototype.watch, decoratorContext('watch', streamInitializers));
const ctx = new Context();
try {
  await ctx.plugin(TypertRegistry);
  await ctx.plugin(BoundaryProbe);
  await ctx.plugin(TypertGatewayService);
  ctx.on('connection/request', async () => { middlewareCalls++; throw Error('enterprise HTTP fence rejects'); });
  assert.deepEqual(await ctx.typertGateway.invoke({ namespace: 'afosProbe', method: 'read', args: {} }), { kind: 'read' });
  const first = [];
  for await (const row of await ctx.typertGateway.stream({ namespace: 'afosProbe', method: 'watch', args: {} })) first.push(row);
  assert.deepEqual(first, [{ kind: 'stream' }]);
  const second = [];
  for await (const row of await ctx.typertGateway.wireStream.open('afosProbe/watch', { args: {} }, (async function* () {})(), undefined, new AbortController().signal)) second.push(row);
  assert.deepEqual(second, [{ kind: 'stream' }]);
  assert.equal(effects, 3);
  assert.equal(middlewareCalls, 0);
  console.log(JSON.stringify({ probe: 'public Gateway invoke, stream, wireStream bypass HTTP connection/request listener', effects, middlewareCalls, result: 'CONFIRMED', scope: 'read-only published API fixture, not enterprise application acceptance' }));
  ctx.typert.lookups.configure('agent', async () => undefined);
  assert.throws(() => ctx.typert.lookups.configure('agent', async () => undefined), /already configured/u);
  ctx.typert.contexts.configureHost('agent', async () => undefined);
  assert.throws(() => ctx.typert.contexts.configureHost('agent', async () => undefined), /already configured/u);
  console.log(JSON.stringify({ probe: 'lookup and Host context policy unique owner', result: 'PASS' }));
} finally {
  await ctx.fiber.dispose();
}
