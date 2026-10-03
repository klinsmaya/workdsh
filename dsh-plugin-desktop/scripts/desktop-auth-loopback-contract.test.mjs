// Opt-in protocol contract: real loopback/TLS and the production 120-second deadline.
// The isolated issuer is a test fixture, not an enterprise IdP or NocoBase instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { DesktopAuth } from '../src/desktop-auth.ts';

if (process.env.AFOS_AUTH_CONTRACT_CHILD !== '1') {
  const space = await statfs(tmpdir());
  assert.ok(space.bavail * space.bsize > 200 * 1024 * 1024, 'temporary disk reserve unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'afos-at08-tls-'));
  try {
    const key = join(directory, 'test-key.pem'), cert = join(directory, 'test-cert.pem');
    const oldMask = process.umask(0o077);
    let prep;
    try {
      prep = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=AFOS local protocol test',
        '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE',
        '-keyout', key, '-out', cert], { timeout: 10_000, maxBuffer: 16_384 });
    } finally { process.umask(oldMask); }
    assert.equal(prep.status, 0, 'test TLS certificate preparation failed');
    const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
    Object.assign(env, { HOME: directory, TMPDIR: directory, NODE_EXTRA_CA_CERTS: cert, AFOS_AUTH_CONTRACT_CHILD: '1', AFOS_AUTH_CONTRACT_TLS: directory });
    const child = spawn(process.execPath, ['--experimental-transform-types', '--test', fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    const forward = destination => chunk => { bytes += chunk.length; if (bytes > 262_144) { child.kill('SIGTERM'); return; } destination.write(chunk); };
    child.stdout.on('data', forward(process.stdout)); child.stderr.on('data', forward(process.stderr));
    const timer = setTimeout(() => child.kill('SIGTERM'), 145_000); timer.unref();
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (exit, signal) => resolve(signal ? 124 : exit ?? 1)); });
    clearTimeout(timer);
    process.exitCode = bytes > 262_144 ? 125 : code;
  } finally {
    // Only this newly owned test TLS directory; no user credentials/Profile are touched.
    await rm(directory, { recursive: true, force: true });
    console.log(JSON.stringify({ testTlsOwnedDirectoryRemoved: true, noEnterpriseIdpOrNocoBase: true }));
  }
} else {
  const tlsDirectory = process.env.AFOS_AUTH_CONTRACT_TLS;
  assert.ok(tlsDirectory);
  const cert = await readFile(join(tlsDirectory, 'test-cert.pem'));
  const key = await readFile(join(tlsDirectory, 'test-key.pem'));

  async function issuer(t) {
    const grants = new Map(), reasons = [], requests = { metadata: 0, authorize: 0, token: 0 };
    let origin;
    const send = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    const server = createServer({ cert, key }, async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', origin);
        if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
          requests.metadata++;
          send(response, 200, { issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', code_challenge_methods_supported: ['S256'] });
        } else if (request.method === 'GET' && url.pathname === '/authorize') {
          requests.authorize++;
          assert.equal(url.searchParams.get('client_id'), 'afos-test-desktop');
          assert.equal(url.searchParams.get('resource'), origin);
          assert.equal(url.searchParams.get('response_type'), 'code');
          assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
          const redirect = new URL(url.searchParams.get('redirect_uri'));
          assert.equal(redirect.protocol, 'http:'); assert.equal(redirect.hostname, '127.0.0.1'); assert.equal(redirect.pathname, '/oauth/callback');
          const code = randomBytes(20).toString('base64url');
          grants.set(code, { challenge: url.searchParams.get('code_challenge'), redirect: redirect.href, used: false });
          redirect.search = new URLSearchParams({ state: url.searchParams.get('state'), code, iss: origin }).toString();
          response.writeHead(302, { Location: redirect.href, 'Cache-Control': 'no-store' }); response.end();
        } else if (request.method === 'POST' && url.pathname === '/token') {
          requests.token++;
          let raw = '';
          for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 4096); }
          const body = new URLSearchParams(raw), grant = grants.get(body.get('code'));
          assert.equal(body.get('client_id'), 'afos-test-desktop'); assert.equal(body.get('resource'), origin); assert.equal(body.get('grant_type'), 'authorization_code'); assert.equal(body.has('client_secret'), false);
          const reason = !grant ? 'UNKNOWN_CODE' : grant.used ? 'CODE_REPLAY' : grant.redirect !== body.get('redirect_uri') ? 'WRONG_REDIRECT' : createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== grant.challenge ? 'WRONG_VERIFIER' : 'ACCEPTED';
          reasons.push(reason);
          if (reason !== 'ACCEPTED') send(response, 400, { error: 'invalid_grant' });
          else { grant.used = true; send(response, 200, { access_token: 'isolated-test-access', token_type: 'Bearer', expires_in: 3600, scope: 'afos' }); }
        } else send(response, 404, { error: 'not_found' });
      } catch { send(response, 500, { error: 'fixture_contract_failed' }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `https://127.0.0.1:${server.address().port}`;
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return { config: { issuer: origin, resource: origin, clientId: 'afos-test-desktop', scope: 'afos' }, requests, reasons };
  }
  async function redirect(href) {
    const response = await fetch(href, { redirect: 'manual', signal: AbortSignal.timeout(3_000) });
    assert.equal(response.status, 302);
    return new URL(response.headers.get('location'));
  }
  async function denied(auth, operation, callback, expectedError) {
    await assert.rejects(operation, error => error?.code === expectedError);
    assert.equal(auth.signedIn, false);
    await assert.rejects(auth.accessToken(), error => error?.code === 'auth/sign-in-required');
    await closed(callback());
  }
  async function closed(url) {
    assert.ok(url instanceof URL); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    assert.ok(Number(url.port) > 0);
    await new Promise((resolve, reject) => {
      const socket = connect({ host: url.hostname, port: Number(url.port) });
      socket.once('connect', () => { socket.destroy(); reject(new Error('callback listener remains open')); });
      socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
      socket.setTimeout(1_000, () => { socket.destroy(); reject(new Error('callback close could not be confirmed')); });
    });
  }

  test('AT08 real loopback/TLS negative transactions', { concurrency: 4, timeout: 135_000 }, async t => {
    await Promise.all([
      t.test('wrong state stays unauthenticated and the original deadline releases its callback', { timeout: 130_000 }, async t => {
        const f = await issuer(t); let callback; const began = performance.now();
        const auth = new DesktopAuth(f.config, async href => {
          callback = await redirect(href); callback.searchParams.set('state', 'AT08_WRONG_STATE');
          const response = await fetch(callback, { signal: AbortSignal.timeout(3_000) });
          assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(auth.signedIn, false);
        });
        await denied(auth, auth.login(), () => callback, 'auth/login-cancelled');
        const elapsedMs = Math.round(performance.now() - began);
        assert.ok(elapsedMs >= 119_000 && elapsedMs < 130_000);
        assert.equal(f.requests.token, 0);
        t.diagnostic(JSON.stringify({ case: 'wrong-state', elapsedMs, originalDeadline: true, tokenRequests: 0, signedIn: false, callbackClosed: true }));
      }),
      t.test('an actual mismatched verifier request is rejected before token installation', { timeout: 10_000 }, async t => {
        const f = await issuer(t); let callback;
        const transport = async (url, init) => {
          if (String(url).endsWith('/token')) {
            const body = new URLSearchParams(String(init.body)); body.set('code_verifier', 'AT08_WRONG_VERIFIER');
            return fetch(url, { ...init, body }); // Real TLS transport; no mocked token response.
          }
          return fetch(url, init);
        };
        const auth = new DesktopAuth(f.config, async href => { callback = await redirect(href); assert.equal((await fetch(callback)).status, 200); }, transport);
        await denied(auth, auth.login(), () => callback, 'auth/invalid-grant');
        assert.deepEqual(f.reasons, ['WRONG_VERIFIER']); assert.equal(f.requests.token, 1);
        t.diagnostic(JSON.stringify({ case: 'wrong-verifier', tokenRequests: 1, reason: f.reasons[0], signedIn: false, callbackClosed: true }));
      }),
      t.test('a used code is rejected in a new transaction with its own valid state', { timeout: 10_000 }, async t => {
        const f = await issuer(t); let firstCallback, callback, usedCode;
        const first = new DesktopAuth(f.config, async href => { firstCallback = await redirect(href); usedCode = firstCallback.searchParams.get('code'); assert.equal((await fetch(firstCallback)).status, 200); });
        await first.login(); assert.equal(first.signedIn, true); first.logout();
        await closed(firstCallback);
        const auth = new DesktopAuth(f.config, async href => { callback = await redirect(href); callback.searchParams.set('code', usedCode); assert.equal((await fetch(callback)).status, 200); });
        await denied(auth, auth.login(), () => callback, 'auth/invalid-grant');
        assert.deepEqual(f.reasons, ['ACCEPTED', 'CODE_REPLAY']); assert.equal(first.signedIn, false); assert.equal(f.requests.token, 2);
        t.diagnostic(JSON.stringify({ case: 'used-code-new-transaction', tokenRequests: f.requests.token, reasons: f.reasons, signedIn: false, callbackClosed: true }));
      }),
      t.test('the original deadline closes a callback while browser opening remains pending', { timeout: 130_000 }, async t => {
        const f = await issuer(t), gate = Promise.withResolvers(); let callback; const began = performance.now();
        const auth = new DesktopAuth(f.config, async href => { callback = await redirect(href); await gate.promise; });
        try {
          await denied(auth, auth.login(), () => callback, 'auth/login-cancelled');
          const elapsedMs = Math.round(performance.now() - began);
          assert.ok(elapsedMs >= 119_000 && elapsedMs < 130_000); assert.equal(f.requests.token, 0);
          t.diagnostic(JSON.stringify({ case: 'original-expiry-pending-browser', elapsedMs, originalDeadline: true, tokenRequests: 0, signedIn: false, callbackClosed: true }));
        } finally { gate.resolve(); auth.logout(); }
      }),
    ]);
  });
}
