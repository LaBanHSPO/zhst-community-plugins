import { useEffect, useRef, useState } from 'react';
import type { AccountingReport, ReportInput, ReportType } from '../../accounting/model.js';
import { accountingRequest } from '../api.js';
import { Failure, Field } from '../shared.js';
import { MasterPicker, vnd } from './shared.js';

const reportLabels: Record<ReportType, string> = { journal: 'Journal', ledger: 'General ledger', 'trial-balance': 'Trial balance', 'cash-bank': 'Cash / bank', debt: 'Party / source debt' };
const totalLabels: Record<string, string> = { openingMinor: 'Opening net (debit − credit)', debitMinor: 'Debit movements', creditMinor: 'Credit movements', closingMinor: 'Closing net (debit − credit)', openingDebitMinor: 'Opening debit', openingCreditMinor: 'Opening credit', closingDebitMinor: 'Closing debit', closingCreditMinor: 'Closing credit', inflowMinor: 'Money-account inflow', outflowMinor: 'Money-account outflow', netFlowMinor: 'Net money movement', originalMinor: 'Original debt sources', allocatedMinor: 'Effective allocations', remainingMinor: 'Source remaining', receivableMinor: 'Receivable sources', payableMinor: 'Payable sources', controlReceivableMinor: 'Receivable control ledger', controlPayableMinor: 'Payable control ledger' };

export function Reports({ onLoading, onOpenJournal }: { onLoading: (value: boolean) => void; onOpenJournal: (id: string) => void }) {
  const [filters, setFilters] = useState<{ type: ReportType; from: string; to: string; accountId: string; partyId: string }>({ type: 'journal', from: '', to: '', accountId: '', partyId: '' });
  const [run, setRun] = useState<{ id: string; input: ReportInput }>();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<AccountingReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const snapshot = useRef<{ id: string; sequence: number } | undefined>(undefined);
  // No start cursor exists in the DTO: retain only the first bounded page of a run.
  const firstPage = useRef<{ id: string; page: AccountingReport } | undefined>(undefined);
  useEffect(() => {
    if (!run) return;
    if (index === 0 && firstPage.current?.id === run.id) {
      setPage(firstPage.current.page); setLoading(false); setError(undefined);
      return;
    }
    const controller = new AbortController();
    setLoading(true); setError(undefined); setPage(undefined);
    accountingRequest<AccountingReport>('report', { ...run.input, cursor: cursors[index] }, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      if (snapshot.current?.id === run.id && snapshot.current.sequence !== value.asOfSequence) { setError(new Error('Report snapshot changed unexpectedly. No pages were combined. Refresh to start a new run.')); setLoading(false); return; }
      snapshot.current = { id: run.id, sequence: value.asOfSequence };
      if (index === 0) firstPage.current = { id: run.id, page: value };
      setPage(value); setLoading(false);
    }, (cause: unknown) => { if (!controller.signal.aborted) { setError(cause); setLoading(false); } });
    return () => controller.abort();
  }, [run, cursors, index, retry]);
  useEffect(() => { onLoading(loading); return () => onLoading(false); }, [loading, onLoading]);
  function start(input: ReportInput) {
    if (input.from > input.to) { setError(new Error('From must be on or before To.')); return; }
    setPage(undefined); setLoading(true); setCursors([undefined]); setIndex(0); setRun({ id: crypto.randomUUID(), input });
  }
  return <section aria-label="Accounting reports" aria-busy={loading}>
    <h2>Reports</h2><p className="erp-muted">Internal ledger, not statutory reporting. Posted originals and reversals are both included at their dates. Totals cover the entire filtered run, not only this page. Amounts are exact whole-dong strings.</p>
    <form onSubmit={(event) => { event.preventDefault(); start({ type: filters.type, from: filters.from, to: filters.to, accountId: filters.accountId || undefined, partyId: filters.partyId || undefined }); }}>
      <fieldset disabled={loading} className="erp-fieldset"><legend>Report filters</legend><div className="erp-form-grid">
        <Field label="Report"><select value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value as ReportType })}>{(Object.keys(reportLabels) as ReportType[]).map((type) => <option key={type} value={type}>{reportLabels[type]}</option>)}</select></Field>
        <Field label="From"><input required type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></Field>
        <Field label="To"><input required type="date" min={filters.from || undefined} value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></Field>
      </div><MasterPicker entity="accounts" label="Report account" optional active={false} value={filters.accountId} onChange={(accountId) => setFilters({ ...filters, accountId })} /><MasterPicker entity="parties" label="Report party" optional active={false} value={filters.partyId} onChange={(partyId) => setFilters({ ...filters, partyId })} />
        <button className="erp-primary" type="submit">{run ? 'Refresh — start new report run' : 'Run report'}</button>
      </fieldset>
    </form>
    {run && <p className="erp-notice">Run: {reportLabels[run.input.type]} · {run.input.from} through {run.input.to} · fixed sequence {snapshot.current?.id === run.id ? snapshot.current.sequence : 'being captured'}. Editing filters does not alter this run’s pages; Refresh starts a new snapshot.</p>}
    {loading && <p role="status">Loading report page…</p>}
    <Failure error={error} retry={run ? () => setRetry((value) => value + 1) : undefined} />
    {page && <>
      <h3>{reportLabels[page.type]} · as of sequence {page.asOfSequence}</h3>
      {page.type === 'debt' && <p className={page.reconciled ? 'erp-notice' : 'erp-error'} role="status">{page.reconciled ? 'Reconciled: source totals match party/account control ledger.' : 'Reconciliation mismatch: source totals do not match control ledger.'} Debt is as at {page.to}; sources before From are included. This is not operational remaining for authorizing a new payment.</p>}
      {page.type === 'trial-balance' && !run?.input.accountId && !run?.input.partyId && <p role="status">Full-book balance: {page.totals.openingDebitMinor === page.totals.openingCreditMinor && page.totals.debitMinor === page.totals.creditMinor && page.totals.closingDebitMinor === page.totals.closingCreditMinor ? 'opening, movements and closing balanced' : 'mismatch — investigate ledger'}.</p>}
      <dl className="erp-form-grid">{Object.entries(page.totals).map(([key, value]) => <div key={key}><dt>{totalLabels[key] ?? key}</dt><dd className="erp-numeric">{vnd(value)}</dd></div>)}</dl>
      {!page.items.length ? <p className="erp-empty">No posted records match this run.</p> : <div className="erp-table-scroll" role="region" aria-label={`${reportLabels[page.type]} results`} tabIndex={0}><table>
        <caption>Page {index + 1} · up to 25 rows · {page.from}–{page.to}</caption>
        <thead>{page.type === 'journal' || page.type === 'ledger' ? <tr><th>Date / journal</th><th>Account / party</th><th>Debit</th><th>Credit</th><th>History</th></tr> : page.type === 'debt' ? <tr><th>Source / party</th><th>Account / date</th><th>Original</th><th>Allocated</th><th>Remaining</th></tr> : <tr><th>Account</th><th>Opening debit</th><th>Opening credit</th><th>Debit</th><th>Credit</th><th>Closing debit</th><th>Closing credit</th></tr>}</thead>
        <tbody>{page.items.map((row) => {
          if (row.kind === 'journal') return <tr key={`${row.journalId}:${row.lineIndex}`}><th scope="row">{row.postingDate}<button type="button" onClick={() => onOpenJournal(row.journalId)}>{row.number} · line {row.lineIndex + 1}</button><small>{row.reference} · sequence {row.postedSequence}</small><small>Posted {row.postedAt} by {row.postedBy}</small></th><td>{row.accountCode} · {row.accountName}<small>{row.partyName ?? '—'} · {row.memo}</small></td><td className="erp-numeric">{vnd(row.debitMinor)}</td><td className="erp-numeric">{vnd(row.creditMinor)}</td><td>{row.reversalOf ? <button type="button" onClick={() => onOpenJournal(row.reversalOf!)}>Original journal</button> : 'Original entry'}{row.reversedBy && <button type="button" onClick={() => onOpenJournal(row.reversedBy!)}>Reversal journal</button>}</td></tr>;
          if (row.kind === 'source') return <tr key={`${row.journalId}:${row.lineIndex}`}><th scope="row"><button type="button" onClick={() => onOpenJournal(row.journalId)}>{row.reference || 'Source'} · line {row.lineIndex + 1}</button><small>{row.partyCode} · {row.partyName} · {row.partyKind}</small></th><td>{row.accountCode} · {row.accountName}<small>{row.postingDate}</small></td><td className="erp-numeric">{vnd(row.originalMinor)}</td><td className="erp-numeric">{vnd(row.allocatedMinor)}</td><td className="erp-numeric">{vnd(row.remainingMinor)}</td></tr>;
          return <tr key={row.accountId}><th scope="row"><button type="button" disabled={loading} onClick={() => { if (!run) return; const input: ReportInput = { ...run.input, type: 'ledger', accountId: row.accountId }; setFilters({ type: 'ledger', from: input.from, to: input.to, accountId: row.accountId, partyId: input.partyId ?? '' }); start(input); }}>Ledger: {row.accountCode}</button><small>{row.accountName} · {row.rootType} · {row.purpose}</small></th><td className="erp-numeric">{vnd(row.openingDebitMinor)}</td><td className="erp-numeric">{vnd(row.openingCreditMinor)}</td><td className="erp-numeric">{vnd(row.debitMinor)}</td><td className="erp-numeric">{vnd(row.creditMinor)}</td><td className="erp-numeric">{vnd(row.closingDebitMinor)}</td><td className="erp-numeric">{vnd(row.closingCreditMinor)}</td></tr>;
        })}</tbody>
      </table></div>}
    </>}
    {run && <nav className="erp-pagination" aria-label="Report pagination"><button type="button" disabled={loading || index === 0} onClick={() => { setPage(undefined); setLoading(true); setIndex((value) => value - 1); }}>Previous</button><span>Page {index + 1} · fixed snapshot</span><button type="button" disabled={loading || !page?.hasMore || !page.cursor} onClick={() => { if (!page?.cursor) return; setCursors((values) => [...values.slice(0, index + 1), page.cursor]); setPage(undefined); setLoading(true); setIndex((value) => value + 1); }}>Next</button></nav>}
  </section>;
}
