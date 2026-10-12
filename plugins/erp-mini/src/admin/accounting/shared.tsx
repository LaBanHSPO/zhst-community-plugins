import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RecordView } from '../../model.js';
import type { Account, AccountingListInput, AccountingPage, Party, PartyKind, SourceSummary, AllocationInput } from '../../accounting/model.js';
import { accountingRequest, parsePrice } from '../api.js';
import { Failure, Field, Search } from '../shared.js';
import type { BlockState } from '../shared.js';

export type WorkspaceProps = { onBlock: (state: BlockState) => void; onLoading: (value: boolean) => void; allowLeave: () => boolean };
export function vnd(value: string | bigint | number): string {
  const text = BigInt(value).toString();
  return `VND ${text.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}
export function dong(value: string): number { return parsePrice(value, 0); }

/** One bounded page, opaque server cursors, abort obsolete requests. */
export function AccountingPaged<T>({ filter, children, onLoading }: {
  filter: AccountingListInput; children: (page: AccountingPage<T>) => ReactNode; onLoading?: (value: boolean) => void;
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<AccountingPage<T>>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const identity = JSON.stringify(filter);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(undefined); setPage(undefined);
    accountingRequest<AccountingPage<T>>('list', { ...JSON.parse(identity), cursor: cursors[index] }, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setPage(value); setLoading(false); }
    }, (cause: unknown) => { if (!controller.signal.aborted) { setError(cause); setLoading(false); } });
    return () => controller.abort();
  }, [identity, cursors, index, retry]);
  useEffect(() => { onLoading?.(loading); return () => onLoading?.(false); }, [loading, onLoading]);
  return <section className="erp-results" aria-busy={loading}>
    {loading && <p role="status">Loading {filter.entity}…</p>}
    <Failure error={error} retry={() => setRetry((value) => value + 1)} />
    {page && (page.items.length ? children(page) : <p className="erp-empty">No matching records. Adjust filters or create a record.</p>)}
    <nav className="erp-pagination" aria-label={`${filter.entity} pagination`}>
      <button type="button" disabled={loading || index === 0} onClick={() => setIndex((value) => value - 1)}>Previous</button>
      <span>Page {index + 1} · {page?.items.length ?? 0} of up to 25 shown</span>
      <button type="button" disabled={loading || !page?.hasMore || !page.cursor} onClick={() => {
        if (!page?.cursor) return;
        setCursors((values) => [...values.slice(0, index + 1), page.cursor]); setIndex((value) => value + 1);
      }}>Next</button>
    </nav>
  </section>;
}

export function MasterPicker({ entity, label, value, onChange, kind, accept, optional = false, active = true }: {
  entity: 'accounts' | 'parties'; label: string; value: string; onChange: (id: string, record?: RecordView<Account | Party>) => void;
  kind?: PartyKind; accept?: (value: Account | Party) => boolean; optional?: boolean; active?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<RecordView<Account | Party>>();
  const [error, setError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const id = useId();
  useEffect(() => {
    setSelected(undefined); setError(undefined); setLoading(Boolean(value));
    if (!value) return;
    const controller = new AbortController();
    accountingRequest<RecordView<Account | Party>>('get', { entity, id: value }, controller.signal).then((entry) => { if (!controller.signal.aborted) { setSelected(entry); setLoading(false); } }, (cause: unknown) => { if (!controller.signal.aborted) { setError(cause); setLoading(false); } });
    return () => controller.abort();
  }, [entity, value, retry]);
  return <div className="erp-picker" aria-labelledby={id} aria-busy={loading} onKeyDown={(event) => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'search') event.preventDefault(); }}>
    <strong id={id}>{label}</strong>
    <p>{selected ? `${selected.value.code} · ${selected.value.name}${selected.value.active ? '' : ' (inactive)'}` : value ? value : 'Not selected'}</p>
    {loading && <p role="status">Loading selected record…</p>}
    <Failure error={error} retry={() => setRetry((value) => value + 1)} />
    <div className="erp-actions"><button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close selector' : `Choose ${label.toLowerCase()}`}</button>{optional && value && <button type="button" onClick={() => { onChange(''); setSelected(undefined); }}>Clear {label.toLowerCase()}</button>}</div>
    {open && <><Search label={`Search ${label.toLowerCase()}`} value={search} onChange={setSearch} />
      <AccountingPaged<Account | Party> key={`${entity}:${search}:${kind}:${active}`} filter={{ entity, search: search || undefined, active: active ? true : undefined, kind }}>
        {(page) => <ul className="erp-picker-list">{page.items.filter((entry) => !accept || accept(entry.value)).map((entry) => <li key={entry.id}><div>{entry.value.code} · {entry.value.name}{'purpose' in entry.value && <small>{entry.value.rootType} · {entry.value.isGroup ? 'group' : entry.value.purpose}</small>}</div><button type="button" onClick={() => { setSelected(entry); onChange(entry.id, entry); setOpen(false); }}>Select {entry.value.code}</button></li>)}</ul>}
      </AccountingPaged>
    </>}
  </div>;
}

export type AllocationForm = AllocationInput & { text: string; source?: SourceSummary };
export function AllocationEditor({ accountId, partyId, values, onChange, max = 49, onOpenJournal }: {
  accountId?: string; partyId: string; values: AllocationForm[]; onChange: (values: AllocationForm[]) => void; max?: number; onOpenJournal: (id: string) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const [sources, setSources] = useState(false);
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const requestController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    setLoading(false);
    return () => requestController.current?.abort();
  }, [accountId, partyId]);
  const key = (value: AllocationInput) => `${value.sourceJournalId}:${value.sourceLineIndex}`;
  async function refreshSelected() {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true); setError(undefined);
    const found = new Map<string, SourceSummary>();
    try {
      let cursor: string | undefined;
      do {
        const page = await accountingRequest<AccountingPage<SourceSummary>>('list', { entity: 'sources', accountId, partyId, cursor }, controller.signal);
        for (const entry of page.items) if (values.some((value) => key(value) === `${entry.value.journalId}:${entry.value.lineIndex}`)) found.set(`${entry.value.journalId}:${entry.value.lineIndex}`, entry.value);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor && found.size < values.length);
      if (controller.signal.aborted) return;
      onChange(values.map((value) => ({ ...value, source: found.get(key(value)) })));
      setRefresh((value) => value + 1);
    } catch (cause) { if (!controller.signal.aborted) setError(cause); } finally { if (!controller.signal.aborted) setLoading(false); }
  }
  return <section aria-label="Source allocations" aria-busy={loading}>
    <fieldset className="erp-unframed" disabled={loading}>
    <p className="erp-muted">Operational remaining includes all posted activity, including future dates. Reports use a separate date cutoff. No advances or overpayments.</p>
    <Failure error={error} retry={() => void refreshSelected()} />
    {values.map((value, index) => <div className="erp-contact" key={key(value)}>
      <button type="button" onClick={() => onOpenJournal(value.sourceJournalId)}>Source {value.source?.reference || value.sourceJournalId} · line {value.sourceLineIndex + 1}</button>
      {value.source ? <p>{value.source.postingDate} · {value.source.accountCode} · Original {vnd(value.source.originalMinor)} · Allocated {vnd(value.source.allocatedMinor)} · Remaining {vnd(value.source.remainingMinor)}</p> : <p className="erp-muted">Refresh remaining before posting; this source may no longer be available.</p>}
      <Field label={`Allocation ${index + 1} · whole VND`}><input required inputMode="numeric" maxLength={13} value={value.text} onChange={(event) => onChange(values.map((entry, position) => position === index ? { ...entry, text: event.target.value } : entry))} /></Field>
      {value.source && /^\d+$/.test(value.text) && <p>After this allocation: {vnd(BigInt(value.source.remainingMinor) - BigInt(value.text))}</p>}
      <button type="button" onClick={() => onChange(values.filter((_, position) => position !== index))}>Remove allocation {index + 1}</button>
    </div>)}
    <div className="erp-actions"><button type="button" disabled={!partyId || values.length >= max || loading} onClick={() => setSources(!sources)}>{sources ? 'Hide sources' : 'Add source allocation'}</button><button type="button" disabled={loading || !values.length} onClick={() => void refreshSelected()}>Refresh operational remaining</button><span>{values.length}/{max} sources</span></div>
    {sources && partyId && <AccountingPaged<SourceSummary> key={`${partyId}:${accountId}:${refresh}`} filter={{ entity: 'sources', partyId, accountId }}>{(page) => <ul className="erp-picker-list">{page.items.map(({ value }) => {
      const selected = values.some((entry) => entry.sourceJournalId === value.journalId && entry.sourceLineIndex === value.lineIndex);
      return <li key={`${value.journalId}:${value.lineIndex}`}><div>{value.reference || value.journalId} · line {value.lineIndex + 1}<small>{value.postingDate} · {value.accountCode} · {value.partyName}</small><p>Original {vnd(value.originalMinor)} · Allocated {vnd(value.allocatedMinor)} · Remaining {vnd(value.remainingMinor)}</p></div><button type="button" disabled={selected || values.length >= max || BigInt(value.remainingMinor) <= 0n} onClick={() => onChange([...values, { sourceJournalId: value.journalId, sourceLineIndex: value.lineIndex, amountMinor: 0, text: '', source: value }])}>Allocate source</button></li>;
    })}</ul>}</AccountingPaged>}
    </fieldset>
  </section>;
}

export function allocationInputs(values: AllocationForm[]): AllocationInput[] {
  return values.map((value) => {
    const amountMinor = dong(value.text);
    if (amountMinor <= 0) throw new Error('Each allocation must be positive.');
    if (value.source && BigInt(amountMinor) > BigInt(value.source.remainingMinor)) throw new Error('Allocation exceeds operational remaining. Refresh sources; advances are not supported.');
    return { sourceJournalId: value.sourceJournalId, sourceLineIndex: value.sourceLineIndex, amountMinor };
  });
}
