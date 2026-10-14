import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountingInfo, Account, Party, Journal, JournalStatus, AccountingListInput, FinancialResult, CoaImportResult } from '../../accounting/model.js';
import type { RecordView } from '../../model.js';
import { accountingRequest } from '../api.js';
import { Failure, Field, Search, useMutation } from '../shared.js';
import type { BlockState } from '../shared.js';
import { BookSetup } from './setup.js';
import { AccountingPaged } from './shared.js';
import type { WorkspaceProps } from './shared.js';
import { AccountEditor, PartyEditor } from './masters.js';
import { JournalDetail, JournalEditor } from './journals.js';
import { SettlementEditor } from './settlements.js';
import { Reports } from './reports.js';
import { FinancialIntentNotice, useFinancialIntent } from './intent.js';
import type { FinancialCommands } from './intent.js';
import { CoaImportPanel } from './coa-import.js';
import { CoaImportIntentNotice, useCoaImportIntent } from './coa-import-intent.js';
import type { RefObject } from 'react';

type Section = 'accounts' | 'parties' | 'journals' | 'receipt' | 'payment' | 'reports';
type Selection = { entity: 'accounts' | 'parties' | 'journals'; id: string; creating: boolean; kind?: 'journal' | 'opening' | 'receipt' | 'payment'; key: string };
type AccountingRecord = Account | Party | Journal;
const sectionLabels: Record<Section, string> = { accounts: 'Accounts', parties: 'Parties', journals: 'Journals', receipt: 'Receipt', payment: 'Payment', reports: 'Reports' };

function RecordPanel({ selection, startDate, onBlock, onLoading, allowLeave, onClose, onChanged, onOpenJournal, commands }: WorkspaceProps & {
  selection: Selection; startDate: string; onClose: () => void; onChanged: () => void; onOpenJournal: (id: string) => void; commands: FinancialCommands;
}) {
  const [record, setRecord] = useState<RecordView<AccountingRecord>>();
  const [loading, setLoading] = useState(!selection.creating);
  const [error, setError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [editing, setEditing] = useState(selection.creating || selection.entity !== 'journals');
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const reload = useMutation();
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (selection.creating) return;
    const controller = new AbortController();
    setLoading(true); setError(undefined);
    accountingRequest<RecordView<AccountingRecord>>('get', { entity: selection.entity, id: selection.id }, controller.signal).then((value) => { if (!controller.signal.aborted) { setRecord(value); setLoading(false); } }, (cause: unknown) => { if (!controller.signal.aborted) { setError(cause); setLoading(false); } });
    return () => controller.abort();
  }, [selection, retry]);
  useEffect(() => { onLoading(loading || reload.pending); return () => onLoading(false); }, [loading, reload.pending, onLoading]);
  function saved(value: RecordView<AccountingRecord>) {
    setRecord(value); setEditing(selection.entity !== 'journals'); setGeneration((value) => value + 1);
    setNotice('status' in value.value ? value.value.status === 'cancelled' ? 'Draft cancelled. History is retained; the ledger is unchanged.' : 'Draft saved. Review the saved lines below, then explicitly Post if correct.' : 'Saved. Stable IDs and historical snapshots are preserved.');
    onChanged();
  }
  function reloadRecord() {
    if (!allowLeave()) return;
    void reload.run(() => accountingRequest<RecordView<AccountingRecord>>('get', { entity: selection.entity, id: selection.id }), (value) => { setRecord(value); setGeneration((value) => value + 1); setEditing(selection.entity !== 'journals'); setNotice('Loaded the latest saved record.'); onChanged(); });
  }
  const editorProps = { id: selection.id, onBlock, onReload: reloadRecord };
  const journal = record as RecordView<Journal> | undefined;
  const kind = journal?.value.kind ?? selection.kind ?? 'journal';
  return <section className="erp-panel" aria-label="Accounting record" aria-busy={loading || reload.pending} onKeyDown={(event) => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'search') event.preventDefault(); }}>
    <div className="erp-panel-heading"><h2 tabIndex={-1} ref={heading}>{selection.creating && !record ? 'New' : 'Saved'} {selection.entity === 'accounts' ? 'account' : selection.entity === 'parties' ? 'party' : `${kind} journal`}</h2><button type="button" disabled={commands.blocked} onClick={onClose}>Back to accounting view</button></div>
    {notice && <p className="erp-notice" role="status">{notice}</p>}
    {loading && <p role="status">Loading current saved record…</p>}
    <Failure error={error} retry={() => setRetry((value) => value + 1)} />
    <Failure error={reload.error} retry={reloadRecord} />
    {reload.pending && <p role="status">Reloading. Local inputs remain until this request succeeds.</p>}
    {!loading && !error && <fieldset className="erp-unframed" disabled={reload.pending || commands.blocked} key={generation}>
      {selection.entity === 'accounts' && <AccountEditor {...editorProps} record={record as RecordView<Account> | undefined} onSaved={saved} />}
      {selection.entity === 'parties' && <PartyEditor {...editorProps} record={record as RecordView<Party> | undefined} onSaved={saved} />}
      {selection.entity === 'journals' && editing && (kind === 'receipt' || kind === 'payment') && <SettlementEditor {...editorProps} kind={kind} startDate={startDate} record={journal} onSaved={saved} onOpenJournal={onOpenJournal} />}
      {selection.entity === 'journals' && editing && (kind === 'journal' || kind === 'opening') && <JournalEditor {...editorProps} kind={kind} startDate={startDate} record={journal} onSaved={saved} onOpenJournal={onOpenJournal} />}
      {selection.entity === 'journals' && !editing && journal && <JournalDetail record={journal} startDate={startDate} onSaved={saved} onBlock={onBlock} commands={commands} onEdit={() => setEditing(true)} onOpenJournal={onOpenJournal} />}
    </fieldset>}
  </section>;
}

function RecordList({ entity, refresh, onLoading, onOpen, onCreate, onImport, importLauncher }: {
  entity: 'accounts' | 'parties' | 'journals'; refresh: number; onLoading: WorkspaceProps['onLoading']; onOpen: (id: string) => void; onCreate: (kind?: 'journal' | 'opening') => void;
  onImport?: () => void; importLauncher?: RefObject<HTMLButtonElement | null>;
}) {
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('active');
  const [partyKind, setPartyKind] = useState('all');
  const [status, setStatus] = useState('all');
  const master = entity !== 'journals';
  const filter: AccountingListInput = master ? { entity, search: search || undefined, active: active === 'all' ? undefined : active === 'active', kind: entity === 'parties' && partyKind !== 'all' ? partyKind as 'customer' | 'supplier' : undefined } : { entity, status: status === 'all' ? undefined : status as JournalStatus };
  return <section aria-label={sectionLabels[entity]}>
    <div className="erp-section-heading"><h2>{sectionLabels[entity]}</h2><div className="erp-actions"><button className="erp-primary" type="button" onClick={() => onCreate(entity === 'journals' ? 'journal' : undefined)}>New {entity === 'accounts' ? 'account' : entity === 'parties' ? 'party' : 'journal'}</button>{entity === 'accounts' && <button type="button" ref={importLauncher} onClick={onImport}>Nhập từ bộ tài khoản mẫu</button>}{entity === 'journals' && <button type="button" onClick={() => onCreate('opening')}>New opening journal</button>}</div></div>
    <div className="erp-toolbar">{master ? <><Search value={search} onChange={setSearch} label="Search code / name" /><Field label="Availability"><select value={active} onChange={(event) => setActive(event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option></select></Field>{entity === 'parties' && <Field label="Party role"><select value={partyKind} onChange={(event) => setPartyKind(event.target.value)}><option value="all">All</option><option value="customer">Customer</option><option value="supplier">Supplier</option></select></Field>}</> : <Field label="Journal status"><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All history</option><option value="draft">Draft</option><option value="posted">Posted</option><option value="cancelled">Cancelled</option></select></Field>}</div>
    <AccountingPaged<AccountingRecord> key={`${JSON.stringify(filter)}:${refresh}`} filter={filter} onLoading={onLoading}>{(page) => <div className="erp-table-scroll" role="region" aria-label={`${sectionLabels[entity]} table`} tabIndex={0}><table><caption>{sectionLabels[entity]} · 25 per page</caption><thead><tr><th>{master ? 'Code / name' : 'Date / number'}</th><th>Type / structure</th><th>Status</th><th>Action</th></tr></thead><tbody>{page.items.map((entry) => {
      const value = entry.value;
      if ('rootType' in value) return <tr key={entry.id}><th scope="row">{value.code}<small>{value.name}</small></th><td>{value.rootType} · {value.isGroup ? 'group' : 'ledger'} · {value.purpose}<small>Parent: {value.parentId ?? 'root'}</small></td><td>{value.active ? 'Active' : 'Inactive'}</td><td><button type="button" onClick={() => onOpen(entry.id)}>Edit account {value.code}</button></td></tr>;
      if ('sourceKind' in value) return <tr key={entry.id}><th scope="row">{value.code}<small>{value.name}</small></th><td>{value.kind}<small>{value.sourceId ? 'Linked CRM snapshot' : 'Independent accounting party'}</small></td><td>{value.active ? 'Active' : 'Inactive'}</td><td><button type="button" onClick={() => onOpen(entry.id)}>Edit party {value.code}</button></td></tr>;
      return <tr key={entry.id}><th scope="row">{value.postingDate}<small>{value.number ?? 'Unposted'} · {value.reference}</small></th><td>{value.kind}<small>{value.memo}</small></td><td>{value.status}{value.reversedBy ? ' · reversed' : ''}</td><td><button type="button" onClick={() => onOpen(entry.id)}>View journal {value.reference || value.number || entry.id}</button></td></tr>;
    })}</tbody></table></div>}</AccountingPaged>
  </section>;
}

function ConfiguredWorkspace({ info, onBlock, onLoading, allowLeave }: WorkspaceProps & { info: AccountingInfo & { book: NonNullable<AccountingInfo['book']> } }) {
  const [section, setSection] = useState<Section>('accounts');
  const [selection, setSelection] = useState<Selection>();
  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<CoaImportResult>();
  const importLauncher = useRef<HTMLButtonElement>(null);
  const [refresh, setRefresh] = useState(0);
  const [receipt, setReceipt] = useState<FinancialResult>();
  const block = useRef<BlockState>({ dirty: false, pending: false });
  const blocked = useRef(false);
  const commands = useFinancialIntent(info.book.value.installationId, (result) => {
    setReceipt(result); setImportOpen(false);
    setSelection({ entity: 'journals', id: result.id, creating: false, key: crypto.randomUUID() });
    setRefresh((value) => value + 1);
  });
  const imports = useCoaImportIntent(info.book.value.installationId, (result) => {
    setImportResult(result); setSection('accounts'); setSelection(undefined); setImportOpen(true);
    setRefresh((value) => value + 1);
  });
  const workspaceBlocked = commands.blocked || imports.blocked;
  blocked.current = workspaceBlocked;
  const financialCommands = { ...commands, blocked: workspaceBlocked };
  const editorBlock = useCallback((value: BlockState) => { block.current = value; onBlock({ dirty: value.dirty || blocked.current, pending: value.pending || blocked.current }); }, [onBlock]);
  useEffect(() => { onBlock({ dirty: block.current.dirty || workspaceBlocked, pending: block.current.pending || workspaceBlocked }); }, [workspaceBlocked, onBlock]);
  useEffect(() => () => onBlock({ dirty: false, pending: false }), [onBlock]);
  function canNavigate() {
    if (workspaceBlocked) { window.alert('Reconcile the retained accounting command before changing this intent or leaving.'); return false; }
    return allowLeave();
  }
  function openJournal(id: string) { if (!canNavigate()) return; setImportOpen(false); setSelection({ entity: 'journals', id, creating: false, key: crypto.randomUUID() }); }
  function openAccount(id: string) { if (!canNavigate()) return; setImportOpen(false); setSection('accounts'); setSelection({ entity: 'accounts', id, creating: false, key: crypto.randomUUID() }); }
  function create(entity: Selection['entity'], kind?: Selection['kind']) { if (!canNavigate()) return; setImportOpen(false); setSelection({ entity, id: crypto.randomUUID(), creating: true, kind, key: crypto.randomUUID() }); }
  function closeImport() {
    if (!canNavigate()) return;
    setImportOpen(false);
    window.requestAnimationFrame(() => importLauncher.current?.focus());
  }
  return <>
    <header className="erp-section-heading"><div><h2>Internal VND book</h2><p className="erp-muted">Starts {info.book.value.startDate} · Whole dong · Separate from CRM/sales; orders never post automatically.</p></div></header>
    <FinancialIntentNotice state={commands} />
    <CoaImportIntentNotice state={imports} />
    {receipt && <p className="erp-notice" role="status">Financial receipt: journal {receipt.id} · sequence {receipt.postedSequence}. Current journal history is loaded separately below.</p>}
    <nav className="erp-actions" aria-label="Accounting sections">{(Object.keys(sectionLabels) as Section[]).map((value) => <button type="button" key={value} className={section === value ? 'erp-primary' : undefined} aria-pressed={section === value} disabled={workspaceBlocked} onClick={() => {
      if (!canNavigate()) return;
      setSection(value); setSelection(undefined); setReceipt(undefined); setImportOpen(false);
      if (value === 'receipt' || value === 'payment') setSelection({ entity: 'journals', id: crypto.randomUUID(), creating: true, kind: value, key: crypto.randomUUID() });
    }}>{sectionLabels[value]}</button>)}</nav>
    {section === 'reports' && <div hidden={Boolean(selection)}><Reports onLoading={onLoading} onOpenJournal={openJournal} /></div>}
    {importOpen ? <CoaImportPanel commands={{ ...imports, blocked: workspaceBlocked }} result={importResult} onBlock={editorBlock} onLoading={onLoading} onClose={closeImport} onOpenAccount={openAccount} /> : selection ? <RecordPanel key={selection.key} selection={selection} startDate={info.book.value.startDate} onBlock={editorBlock} onLoading={onLoading} allowLeave={allowLeave} commands={financialCommands} onClose={() => { if (canNavigate()) { setSelection(undefined); if (section === 'receipt' || section === 'payment') setSection('journals'); } }} onChanged={() => setRefresh((value) => value + 1)} onOpenJournal={openJournal} /> : (section === 'accounts' || section === 'parties' || section === 'journals') && <fieldset className="erp-unframed" disabled={workspaceBlocked}><RecordList key={section} entity={section} refresh={refresh} onLoading={onLoading} onOpen={(id) => { if (canNavigate()) setSelection({ entity: section, id, creating: false, key: crypto.randomUUID() }); }} onCreate={(kind) => create(section, kind)} importLauncher={importLauncher} onImport={() => { if (canNavigate()) { setSelection(undefined); setImportOpen(true); } }} /></fieldset>}
  </>;
}

export function AccountingWorkspace({ onBlock, onLoading, allowLeave }: WorkspaceProps) {
  const [info, setInfo] = useState<AccountingInfo>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [childLoading, setChildLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(undefined);
    accountingRequest<AccountingInfo>('info', undefined, controller.signal).then((value) => { if (!controller.signal.aborted) { setInfo(value); setLoading(false); } }, (cause: unknown) => { if (!controller.signal.aborted) { setError(cause); setLoading(false); } });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => { onLoading(loading || childLoading); return () => onLoading(false); }, [loading, childLoading, onLoading]);
  const reload = () => { if (allowLeave()) setRetry((value) => value + 1); };
  return <section aria-label="Internal accounting" aria-busy={loading}>
    <Failure error={error} retry={reload} />
    {loading && <p role="status">Loading accounting book…</p>}
    {!loading && !error && info && (info.book ? <ConfiguredWorkspace info={{ ...info, book: info.book }} onBlock={onBlock} onLoading={setChildLoading} allowLeave={allowLeave} /> : <BookSetup onBlock={onBlock} onReload={reload} onConfigured={(book) => setInfo({ ...info, book })} />)}
  </section>;
}
