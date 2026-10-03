import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { runtimeBindingDomainSpec } from 'workdsh-plugin-access';

// Opt-in test observer, installed only by the isolated original-CLI test profile.
// Seed through original public persistence/domain APIs; never through a caller.
export const name = 'afos-private-test-owner-consumer';
export const inject = ['afosCliCoreReady', 'afosCliNativeReady', 'afosDraftRuntime', 'connection', 'webServer',
  'workdshAccess', 'storageDomain', 'sessionPersistence', 'agents', 'sessions'];
const sha = value => createHash('sha256').update(value).digest('hex');
export function apply(ctx, config) {
  const publications = [];
  ctx.on('agent/created', ({ agent }) => publications.push({ id: String(agent.id),
    owner: ctx.workdshAccess.sessionOwner(String(agent.id)) ?? null }));
  const stats = () => ({ agents: ctx.agents.list().length, sessions: ctx.sessions.list().length,
    publications, selected: ctx.afosDraftRuntime.nativeSessionId() ?? null,
    personalAutoBindService: Boolean(ctx.get('workdshToolAccess') || ctx.get('workdshSessionAccess')) });
  const persisted = async ids => {
    assert.ok(Array.isArray(ids) && ids.length === 3);
    const domain = ctx.storageDomain.get(runtimeBindingDomainSpec.name); assert.ok(domain);
    const result = [];
    for (const id of ids) {
      assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
      const handle = await ctx.sessionPersistence.open(id, 'read'); let logical;
      try { logical = { header: handle.header, events: (await handle.read()).events }; }
      finally { await handle.close(); }
      assert.equal(logical.header.id, id);
      const file = await ctx.sessionPersistence.resolveCurrentLog(id);
      const path = relative(join(config.root, 'sessions'), file);
      assert.ok(path && !path.startsWith('..') && !isAbsolute(path));
      const info = await lstat(file);
      assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size < 65536);
      const raw = await readFile(file), owner = ctx.workdshAccess.sessionOwner(id) ?? null;
      assert.deepEqual(domain.table('sessions').get(id) ?? null, owner);
      result.push({ id, owner, logicalSha256: sha(JSON.stringify(logical)),
        file: { path, bytes: raw.length, mode: info.mode & 0o777, sha256: sha(raw) } });
    }
    return result;
  };
  const commands = {
    stats,
    persisted: ({ ids }) => persisted(ids),
    seed: async ({ sessionId }) => {
      const agent = ctx.agents.get(sessionId); assert.ok(agent);
      await agent.whenIdle(); await ctx.sessionPersistence.flush();
      const publication = publications.find(row => row.id === sessionId); assert.ok(publication?.owner);
      const foreign = 'foreign-' + randomUUID(), orphan = 'ownerless-' + randomUUID();
      for (const id of [foreign, orphan]) {
        const handle = await ctx.sessionPersistence.create({ ...agent.session.header, id });
        try { await handle.flush(); } finally { await handle.close(); }
      }
      const domain = ctx.storageDomain.get(runtimeBindingDomainSpec.name); assert.ok(domain);
      await domain.table('sessions').put(foreign, { ...publication.owner, sessionId: foreign,
        ownerPrincipalId: 'bob', revision: 'fixture-existing-foreign-owner' });
      assert.equal(ctx.workdshAccess.sessionOwner(orphan), undefined);
      const ids = [sessionId, foreign, orphan]; return { ids, before: await persisted(ids), stats: stats() };
    },
  };
  ctx.effect(() => {
    const input = createInterface({ input: process.stdin }); let tail = Promise.resolve();
    const accept = line => {
      tail = tail.then(async () => {
        let request;
        try {
          assert.ok(line.length < 4096); request = JSON.parse(line);
          assert.ok(Number.isSafeInteger(request.id) && Object.hasOwn(commands, request.method));
          const value = await commands[request.method](request.payload ?? {});
          process.stdout.write('AFOS_OWNER_RESULT ' + JSON.stringify({ id: request.id, ok: true, value }) + '\n');
        } catch (error) {
          const failureLine = /cli-owner-consumer\.mjs:(\d+):/u.exec(error?.stack ?? '')?.[1];
          process.stdout.write('AFOS_OWNER_RESULT ' + JSON.stringify({ id: request?.id, ok: false,
            code: 'fixture-command-refused', failureLine }) + '\n');
        }
      });
    };
    input.on('line', accept); return () => { input.off('line', accept); input.close(); };
  });
  const url = new URL(ctx.connection.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port + '/'));
  let headers, status;
  ctx.connection.authorizeIndex({ method: 'GET', url: url.pathname + url.search, headers: { host: url.host } },
    { writeHead(s, h) { status = s; headers = h; }, end() {} });
  assert.equal(status, 303);
  const cookie = headers['Set-Cookie'] ?? headers['set-cookie'];
  // Private stdout control frame stays in memory; reports never print cookie.
  process.stdout.write('AFOS_OWNER_READY ' + JSON.stringify({ pid: process.pid, ppid: process.ppid,
    authority: url.host, cookie: (Array.isArray(cookie) ? cookie[0] : cookie).split(';')[0],
    root: config.root, originalLoader: Boolean(ctx.root.get('loader')),
    rootPrivate: !ctx.root.get('afosMainBusiness') && !ctx.root.get('agents') && !ctx.root.get('afosNativeCallerProof') }) + '\n');
}
