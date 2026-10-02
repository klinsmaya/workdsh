import { fixture, reservation } from './sql-fixture.mjs';

const cleanup = [];
const f = await fixture({ after: callback => cleanup.push(callback) }, {
  storage: process.argv[2], noSync: true, noSeed: true,
});
// Both processes finish a real SELECT in their own transaction before writing.
// This barrier induces contention; it does not provide a JS transaction mutex.
const repository = f.db.getRepository('afosModelBudgets');
const find = repository.findOne.bind(repository);
let release;
const write = new Promise(resolve => { release = resolve; });
repository.findOne = async options => {
  const value = await find(options);
  process.send({ type: 'snapshot' });
  await write;
  return value;
};
process.on('message', async message => {
  if (message.type === 'write') { release(); return; }
  if (message.type !== 'reserve') return;
  let result;
  try {
    await f.ledger.reserve(reservation(process.argv[3]));
    result = { type: 'result', status: 'fulfilled' };
  } catch (error) {
    result = { type: 'result', status: 'rejected', code: error.code ?? error.parent?.code ?? error.original?.code };
  }
  for (const callback of cleanup) await callback();
  process.send(result, () => { process.disconnect(); });
});
process.send({ type: 'ready' });
