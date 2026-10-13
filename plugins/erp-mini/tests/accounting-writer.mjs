import { AccountingService } from '../src/accounting/service.ts';
import { openAccountingDatabase } from '../src/accounting/sqlite.ts';

// IPC is an explicit start barrier: both independent SQLite processes open before either posts.
const store = openAccountingDatabase(process.argv[2]);
const service = new AccountingService(store, process.argv[3], () => new Date('2030-01-01T12:00:00.000Z'));
process.once('message', async (input) => {
  let outcome;
  try { outcome = { ok: true, result: await service.postJournal(input) }; }
  catch (error) { outcome = { ok: false, code: error.code ?? 'INTERNAL_ERROR' }; }
  finally { store.close(); }
  process.send(outcome, () => process.disconnect());
});
process.send({ ready: true });
