import { AccountingService } from '../src/accounting/service.ts';
import { openAccountingDatabase } from '../src/accounting/sqlite.ts';

// IPC is an explicit start barrier: independent SQLite processes open before writes.
const store = openAccountingDatabase(process.argv[2]);
const service = new AccountingService(store, process.argv[3], () => new Date('2030-01-01T12:00:00.000Z'));
process.once('message', async (input) => {
  let outcome;
  try {
    const result = process.argv[4] === 'import-accounts'
      ? await service.importAccounts(input)
      : await service.postJournal(input);
    outcome = { ok: true, result };
  }
  catch (error) { outcome = { ok: false, code: error.code ?? 'INTERNAL_ERROR' }; }
  finally { store.close(); }
  process.send(outcome, () => process.disconnect());
});
process.send({ ready: true });
