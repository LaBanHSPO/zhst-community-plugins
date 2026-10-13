// Disposable Miniflare fixture only. Never included in the production Worker or package exports.
import { DurableObject } from 'cloudflare:workers';
import { openDurableAccountingStore, migrateDurableAccountingStore, durableAccountingSchemaStatus } from '../dist/accounting/cloudflare.mjs';
import { AccountingService, executeAccountingAction, ErpError } from '../dist/accounting/server.mjs';

const now = () => new Date('2030-01-01T12:00:00.000Z');
function code(work) {
  try { work(); return 'NO_ERROR'; }
  catch (error) { return error instanceof ErpError ? error.code : 'UNMAPPED_ERROR'; }
}
function withFault(store) {
  return {
    get: store.get.bind(store), all: store.all.bind(store), transaction: store.transaction.bind(store), close: store.close.bind(store),
    run(sql, ...parameters) {
      const result = store.run(sql, ...parameters);
      if (sql.startsWith('INSERT INTO erp_ac_commands')) throw new Error('Synthetic fault after receipt insertion');
      return result;
    },
  };
}
export class TestAccounting extends DurableObject {
  async fetch(request) {
    try {
      const { operation, action, input, actor = 'admin-1' } = await request.json();
      const storage = this.ctx.storage;
      if (operation === 'status') return Response.json({ ok: true, data: durableAccountingSchemaStatus(storage) });
      if (operation === 'migrate') {
        migrateDurableAccountingStore(storage);
        return Response.json({ ok: true, data: durableAccountingSchemaStatus(storage) });
      }
      if (operation === 'migration-fault') {
        const fault = {
          transactionSync: storage.transactionSync.bind(storage),
          sql: { exec(sql, ...bindings) {
            const result = storage.sql.exec(sql, ...bindings);
            if (sql.includes('CREATE TABLE erp_ac_migrations')) { result.toArray(); throw new Error('Synthetic DDL interruption'); }
            return result;
          } },
        };
        const failure = code(() => migrateDurableAccountingStore(fault));
        return Response.json({ ok: true, data: { failure, status: durableAccountingSchemaStatus(storage) } });
      }
      if (operation === 'raw') {
        const result = storage.sql.exec(input.sql, ...(input.parameters ?? [])).toArray();
        return Response.json({ ok: true, data: result });
      }
      if (operation === 'internal-kv') {
        await storage.put('synthetic-runtime-key', 1);
        return Response.json({ ok: true, data: durableAccountingSchemaStatus(storage) });
      }
      const store = openDurableAccountingStore(storage);
      try {
        if (operation === 'adapter-probe') {
          const insert = () => store.run("INSERT INTO erp_ac_audit VALUES(?,'book','book',NULL,'test','admin-1',?,'r1',NULL)", crypto.randomUUID(), now().toISOString());
          const rollback = code(() => store.transaction(() => { insert(); throw new Error('fault'); }));
          const nested = code(() => store.transaction(() => store.transaction(insert)));
          const other = openDurableAccountingStore(storage);
          const crossAdapterNested = code(() => store.transaction(() => other.transaction(insert)));
          other.close();
          const closeDuringTransaction = code(() => store.transaction(() => store.close()));
          let asyncCalled = false;
          const async = code(() => store.transaction(async () => { asyncCalled = true; insert(); }));
          const safeBigint = store.get('SELECT ? AS value', 9007199254740991n).value;
          const unsafeBigint = code(() => store.get('SELECT ? AS value', 9007199254740992n));
          const fractional = code(() => store.get('SELECT ? AS value', 1.5));
          const unsafeRead = code(() => store.get('SELECT 9007199254740993 AS value'));
          let continuation = 'NOT_CALLED';
          const thenable = code(() => store.transaction(() => {
            insert();
            return Promise.resolve().then(() => { continuation = code(insert); });
          }));
          await Promise.resolve();
          await Promise.resolve();
          const reopened = openDurableAccountingStore(storage);
          const auditCount = reopened.get('SELECT count(*) AS count FROM erp_ac_audit').count;
          reopened.close();
          return Response.json({ ok: true, data: { rollback, nested, crossAdapterNested, closeDuringTransaction, async, asyncCalled, thenable, continuation, auditCount, safeBigint, unsafeBigint, fractional, unsafeRead } });
        }
        if (operation === 'write-probe') {
          const auditId = crypto.randomUUID();
          const inserted = store.run("INSERT INTO erp_ac_audit VALUES(?,'book','book',NULL,'test','admin-1',?,'r1',NULL)", auditId, now().toISOString());
          const immutable = code(() => store.run("UPDATE erp_ac_audit SET actorId='forged' WHERE id=?", auditId));
          const duplicate = code(() => store.run("INSERT INTO erp_ac_audit VALUES(?,'book','book',NULL,'forged','admin-2',?,'r2',NULL)", auditId, now().toISOString()));
          const saved = store.get('SELECT event,actorId,revision FROM erp_ac_audit WHERE id=?', auditId);
          const count = store.get('SELECT count(*) AS count FROM erp_ac_audit').count;
          store.close();
          const closed = code(() => store.get('SELECT 1'));
          return Response.json({ ok: true, data: { changes: inserted.changes, immutable, duplicateRejected: duplicate !== 'NO_ERROR', saved, count, closed } });
        }
        if (operation === 'large-totals') {
          const service = new AccountingService(store, actor, now);
          const lines = [];
          for (let index = 0; index < 25; index++) {
            lines.push({ accountId: input.bank, partyId: null, debitMinor: 1_000_000_000_000, creditMinor: 0, allocations: [] }, { accountId: input.equity, partyId: null, debitMinor: 0, creditMinor: 1_000_000_000_000, allocations: [] });
          }
          for (let index = 0; index < 363; index++) {
            const draft = await service.saveJournal({ id: crypto.randomUUID(), revision: null, kind: 'journal', postingDate: '2030-02-01', memo: 'Exact workerd numeric fixture', reference: 'TEST', lines: index === 362 ? [{ ...lines[0], debitMinor: 1 }, { ...lines[1], creditMinor: 1 }] : lines });
            await service.postJournal({ id: draft.id, revision: draft.revision, commandId: crypto.randomUUID() });
          }
          const reports = {};
          for (const type of ['journal', 'ledger', 'trial-balance', 'cash-bank']) {
            const filter = { type, from: '2030-01-01', to: '2030-12-31', ...(type === 'ledger' ? { accountId: input.bank } : {}) };
            const first = await service.report(filter);
            reports[type] = { totals: first.totals, asOfSequence: first.asOfSequence, nextTotals: first.hasMore ? (await service.report({ ...filter, cursor: first.cursor })).totals : null };
          }
          return Response.json({ ok: true, data: reports });
        }
        const service = new AccountingService(operation === 'post-fault' ? withFault(store) : store, actor, now);
        return Response.json(await executeAccountingAction(service, action, input));
      } finally { store.close(); }
    } catch (error) {
      if (error instanceof ErpError) return Response.json({ ok: false, error: { code: error.code, message: error.message } });
      return Response.json({ ok: false, error: { code: 'HARNESS_ERROR', message: error instanceof Error ? error.message : String(error) } });
    }
  }
}
export default { fetch() { return new Response('Test-only worker', { status: 404 }); } };
