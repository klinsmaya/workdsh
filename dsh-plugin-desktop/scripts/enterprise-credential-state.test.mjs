import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../../enterprise/plugin-agent-bridge/src/server/__tests__/desktop-fixture.mjs';
import { credentialStorageUi } from '../src/enterprise-credential-state.ts';

// Real Main/Auth/Broker with the existing controlled HTTPS/OS fixture; not IdP or target-OS acceptance.
test('refused credential persistence leaves a clear native memory-only state and no vault file', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  f.vault.save = async () => false;
  assert.equal(f.main.credentialStorageState(), 'signed-out');
  await f.main.signIn();
  assert.equal(f.main.credentialStorageState(), 'memory-only');
  await f.main.selectProject('p1');
  const ui = credentialStorageUi(f.main.credentialStorageState());
  assert.match(ui.label, /仅本次内存/u); assert.match(ui.detail, /重启 WorkDSH 后需重新登录/u);
  for (const secret of ['fixture-access', 'fixture-refresh', f.base, 'device1', 'alice']) assert.ok(!JSON.stringify(ui).includes(secret));
  await assert.rejects(readdir(join(f.base, 'vault')), { code: 'ENOENT' });
  await f.main.logout(); assert.equal(f.main.credentialStorageState(), 'signed-out');
});

test('a rotated refresh token that cannot be persisted updates the current account state', async t => {
  const f = await fixture({ shortTokens: true }); t.after(() => f.cleanup());
  const observed = [], unobserve = f.main.observeCredentialStorage(() => observed.push(f.main.credentialStorageState()));
  t.after(unobserve);
  const failedObserver = f.main.observeCredentialStorage(() => { throw new Error('fixture/native-presentation-failed'); });
  t.after(failedObserver);
  await f.ready(); assert.equal(f.main.credentialStorageState(), 'encrypted');
  assert.equal(observed.at(-1), 'encrypted');
  assert.equal(credentialStorageUi(f.main.credentialStorageState()).detail, undefined);
  f.vault.save = async () => false;
  await f.main.currentAuthority(); assert.equal(f.main.credentialStorageState(), 'memory-only');
  assert.equal(observed.at(-1), 'memory-only');
  unobserve(); const before = observed.length;
  await f.main.logout(); assert.equal(observed.length, before);
});

test('late persistence from an old account operation cannot publish its state into a new sign-in', async t => {
  const f = await fixture(); t.after(() => f.cleanup()); await f.main.signIn();
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const save = f.vault.save.bind(f.vault);
  f.vault.save = async () => { entered.resolve(); await gate.promise; return true; };
  const old = f.main.selectProject('p1'); old.catch(() => {}); await entered.promise;
  assert.equal(f.main.credentialStorageState(), 'memory-only');
  const fresh = f.main.signIn();
  assert.equal(f.main.credentialStorageState(), 'signed-out');
  gate.resolve(); await assert.rejects(old, /account-changed/u); await fresh;
  assert.equal(f.main.credentialStorageState(), 'memory-only');
  f.vault.save = save;
});

test('logout during a credential-state notification cannot publish old account readiness', async t => {
  for (const operation of ['select', 'restore']) await t.test(operation, async child => {
    const f = await fixture(); child.after(() => f.cleanup());
    let binding;
    if (operation === 'restore') { binding = (await f.ready()).binding; await f.main.suspend(); }
    else await f.main.signIn();
    let logout, started = false;
    const unobserve = f.main.observeCredentialStorage(() => {
      if (f.main.credentialStorageState() === 'encrypted' && !started) {
        started = true; logout = f.main.logout();
      }
    });
    child.after(unobserve);
    const pending = operation === 'restore' ? f.main.restoreAccount(binding, 'p1') : f.main.selectProject('p1');
    await assert.rejects(pending, /account-changed/u); await logout;
    assert.equal(f.main.credentialStorageState(), 'signed-out');
    await assert.rejects(f.main.currentAuthority(), /select-project-required/u);
  });
});
