import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginAdminExports } from 'emdash';
import type { Customer, Entity, Info, Item, RecordView, Sale } from '../model.js';
import { money, request } from './api.js';
import { CustomerEditor, ItemEditor } from './masters.js';
import { QuoteEditor, SaleDetail } from './sales.js';
import { AccountingWorkspace } from './accounting/index.js';
import { Failure, Paged, Search, useMutation } from './shared.js';
import type { BlockState } from './shared.js';
import './styles.css';

const tabs: { entity: Entity; label: string; singular: string; description: string }[] = [
  { entity: 'customers', label: 'Customers', singular: 'customer', description: 'Manage your customers and the people you work with.' },
  { entity: 'items', label: 'Items', singular: 'item', description: 'Keep products, services and exact unit prices in one place.' },
  { entity: 'quotes', label: 'Quotations', singular: 'quotation', description: 'Draft, submit and accept an offer, then create its sales order.' },
  { entity: 'orders', label: 'Orders', singular: 'order', description: 'Track accepted sales through fulfillment or cancellation.' },
];

type BusinessRecord = Customer | Item | Sale;
type WorkspaceSection = Entity | 'accounting';
type Selection = { entity: Entity; id: string; creating: boolean; key: string };

function RecordPanel({ selection, info, onBlock, onLoading, allowLeave, onClose, onChanged, onRelated }: {
  selection: Selection; info: Info; onBlock: (state: BlockState) => void; onLoading: (loading: boolean) => void;
  allowLeave: () => boolean; onClose: () => void; onChanged: () => void; onRelated: (entity: 'quotes' | 'orders', id: string) => void;
}) {
  const [record, setRecord] = useState<RecordView<BusinessRecord>>();
  const [loading, setLoading] = useState(!selection.creating);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);
  const [editing, setEditing] = useState(selection.creating);
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const reload = useMutation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (selection.creating) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    request<RecordView<BusinessRecord>>('get', { entity: selection.entity, id: selection.id }, controller.signal).then((value) => {
      setRecord(value); setLoading(false);
    }, (error: unknown) => { if (!controller.signal.aborted) { setLoadError(error); setLoading(false); } });
    return () => controller.abort();
  }, [selection, retry]);
  useEffect(() => { onLoading(loading || reload.pending); return () => onLoading(false); }, [loading, reload.pending, onLoading]);
  function saved(value: RecordView<BusinessRecord>) {
    setRecord(value);
    setEditing(false);
    setGeneration((current) => current + 1);
    setNotice('Saved. The details below reflect the server record.');
    onChanged();
  }
  function reloadRecord() {
    if (!allowLeave()) return;
    void reload.run(() => request<RecordView<BusinessRecord>>('get', { entity: selection.entity, id: selection.id }), (value) => {
      setRecord(value);
      setEditing(false);
      setGeneration((current) => current + 1);
      setNotice('Loaded the latest saved record.');
      onChanged();
    });
  }
  const editorProps = { id: selection.id, onBlock, onReload: reloadRecord };
  const entityLabel = tabs.find((tab) => tab.entity === selection.entity)?.singular ?? 'record';
  return <section className="erp-panel" aria-labelledby="erp-record-heading">
    <div className="erp-panel-heading"><h2 id="erp-record-heading" ref={heading} tabIndex={-1}>{record ? `${entityLabel[0]?.toUpperCase()}${entityLabel.slice(1)} details` : selection.creating ? `New ${entityLabel}` : `Loading ${entityLabel}`}</h2><button type="button" onClick={onClose}>Back to list</button></div>
    {notice && <p role="status" className="erp-notice">{notice}</p>}
    {loading && <p role="status">Loading saved record…</p>}
    <Failure error={loadError} retry={() => setRetry((value) => value + 1)} />
    <Failure error={reload.error} retry={reloadRecord} />
    {reload.pending && <p role="status">Reloading saved record. Your current form is retained until the request succeeds…</p>}
    {!loading && !loadError && <fieldset className="erp-unframed" disabled={reload.pending} key={generation}>
      {selection.entity === 'customers' && <CustomerEditor {...editorProps} record={record as RecordView<Customer> | undefined} onSaved={saved} />}
      {selection.entity === 'items' && <ItemEditor {...editorProps} info={info} record={record as RecordView<Item> | undefined} onSaved={saved} />}
      {selection.entity === 'quotes' && (editing || !record) && <QuoteEditor {...editorProps} info={info} record={record as RecordView<Sale> | undefined} onSaved={saved} />}
      {(selection.entity === 'orders' || (selection.entity === 'quotes' && !editing)) && record && <SaleDetail {...editorProps} record={record as RecordView<Sale>} orderView={selection.entity === 'orders'} onEdit={() => { setEditing(true); setNotice(''); }} onOpenRelated={onRelated} onSaved={(value, action) => {
        if (action === 'convert') { onChanged(); onRelated('orders', value.id); }
        else saved(value);
      }} />}
    </fieldset>}
  </section>;
}

function RecordList({ entity, info, refresh, onOpen, onCreate }: { entity: Entity; info: Info; refresh: number; onOpen: (id: string) => void; onCreate: () => void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('active');
  const master = entity === 'customers' || entity === 'items';
  const config = tabs.find((tab) => tab.entity === entity)!;
  return <section aria-label={config.label}>
    <div className="erp-section-heading"><div><h2>{config.label}</h2><p className="erp-muted">{config.description}</p></div>{entity !== 'orders' && <button className="erp-primary" type="button" onClick={onCreate}>New {config.singular}</button>}</div>
    {master && <div className="erp-toolbar"><Search value={search} onChange={setSearch} /><label className="erp-field"><span>Availability</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All records</option></select></label></div>}
    {!master && <p className="erp-muted">{entity === 'orders' ? 'Orders are created from accepted quotations, not entered separately.' : 'Draft → Submitted → Accepted → Converted. Cancellation is available before conversion.'}</p>}
    <Paged<BusinessRecord> key={`${entity}:${search}:${filter}:${refresh}`} entity={entity} search={master ? search : undefined} active={master && filter !== 'all' ? filter === 'active' : undefined}>{(page) => <div className="erp-table-scroll" role="region" aria-label={`${config.label} table`} tabIndex={0}><table>
      <caption>{config.label} · up to {info.pageSize} per page</caption>
      <thead><tr><th scope="col">{master ? 'Name / code' : 'Reference / number'}</th><th scope="col">{master ? entity === 'customers' ? 'Contact' : 'Unit' : 'Customer'}</th><th scope="col">Status</th><th scope="col" className={entity !== 'customers' ? 'erp-numeric' : undefined}>{entity === 'customers' ? 'Contacts' : entity === 'items' ? 'Unit price' : 'Total'}</th><th scope="col">Action</th></tr></thead>
      <tbody>{page.items.map((entry) => {
        const value = entry.value;
        if ('contacts' in value) return <tr key={entry.id}><th scope="row">{value.name}<small>{value.code}</small></th><td>{value.email || value.phone || '—'}</td><td><span className="erp-status">{value.active ? 'Active' : 'Archived'}</span></td><td>{value.contacts.length}</td><td><button type="button" onClick={() => onOpen(entry.id)} aria-label={`Edit customer ${value.name}`}>Edit</button></td></tr>;
        if ('priceMinor' in value) return <tr key={entry.id}><th scope="row">{value.name}<small>{value.code}</small></th><td>{value.unit}</td><td><span className="erp-status">{value.active ? 'Active' : 'Archived'}</span></td><td className="erp-numeric">{money(value.priceMinor, value.currency)}</td><td><button type="button" onClick={() => onOpen(entry.id)} aria-label={`Edit item ${value.name}`}>Edit</button></td></tr>;
        return <tr key={entry.id}><th scope="row">{value.reference || (entity === 'orders' ? 'Sales order' : 'Quotation')}<small className="erp-number">{entity === 'orders' ? value.order?.number : value.number}</small></th><td>{value.customer.name}</td><td><span className="erp-status">{entity === 'orders' ? value.order?.status : value.status}</span></td><td className="erp-numeric">{money(value.totalMinor, value.currency)}</td><td><button type="button" onClick={() => onOpen(entry.id)} aria-label={`Open ${config.singular} ${value.reference || value.number}`}>View</button></td></tr>;
      })}</tbody>
    </table></div>}</Paged>
  </section>;
}

function Workspace() {
  const [tab, setTab] = useState<WorkspaceSection>(() => {
    const value = typeof window === 'undefined' ? null : new URL(window.location.href).searchParams.get('erpTab');
    return value === 'accounting' ? 'accounting' : tabs.find((candidate) => candidate.entity === value)?.entity ?? 'customers';
  });
  const [info, setInfo] = useState<Info>();
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState<Selection>();
  const [refresh, setRefresh] = useState(0);
  const block = useRef<BlockState>({ dirty: false, pending: false });
  const loading = useRef(false);
  const currentUrl = useRef(typeof window === 'undefined' ? '' : window.location.href);
  const currentHistoryState = useRef<unknown>(typeof window === 'undefined' ? null : window.history.state);
  const root = useRef<HTMLDivElement>(null);
  const onBlock = useCallback((state: BlockState) => { block.current = state; }, []);
  const onLoading = useCallback((value: boolean) => { loading.current = value; }, []);
  const allowLeave = useCallback(() => {
    if (block.current.pending || loading.current) { window.alert('Please wait for the current request to finish before leaving.'); return false; }
    return !block.current.dirty || window.confirm('Discard your unsaved changes? Your changes will not be saved.');
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    request<Info>('info', undefined, controller.signal).then(setInfo, (cause: unknown) => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (block.current.dirty || block.current.pending) { event.preventDefault(); event.returnValue = ''; }
    }
    function outsideNavigation(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(target instanceof HTMLAnchorElement) || target.hasAttribute('data-erp-tab') || target.target === '_blank' || target.hasAttribute('download') || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (!allowLeave()) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
    function popstate(event: PopStateEvent) {
      if (!allowLeave()) {
        event.stopImmediatePropagation();
        window.history.pushState(currentHistoryState.current, '', currentUrl.current);
        return;
      }
      currentUrl.current = window.location.href;
      currentHistoryState.current = window.history.state;
      const value = new URL(window.location.href).searchParams.get('erpTab');
      setTab(value === 'accounting' ? 'accounting' : tabs.find((candidate) => candidate.entity === value)?.entity ?? 'customers');
      setSelection(undefined);
      block.current = { dirty: false, pending: false };
    }
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', outsideNavigation, true);
    window.addEventListener('popstate', popstate, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', outsideNavigation, true); window.removeEventListener('popstate', popstate, true); };
  }, [allowLeave]);
  function navigate(entity: WorkspaceSection) {
    const url = new URL(window.location.href);
    url.searchParams.set('erpTab', entity);
    window.history.pushState(window.history.state, '', url);
    currentUrl.current = url.href;
    currentHistoryState.current = window.history.state;
    setTab(entity);
    setSelection(undefined);
    block.current = { dirty: false, pending: false };
  }
  function openRelated(entity: 'quotes' | 'orders', id: string) {
    navigate(entity);
    setSelection({ entity, id, creating: false, key: crypto.randomUUID() });
  }
  const workspaceTabs: { entity: WorkspaceSection; label: string }[] = info?.accounting ? [...tabs, { entity: 'accounting', label: 'Accounting' }] : tabs;
  return <div className="erp-mini" ref={root}>
    <header className="erp-header"><div><p className="erp-eyebrow">CRM & sales</p><h1>ERP mini</h1><p>From your first customer to a fulfilled order.</p></div>{info && <span className="erp-currency">{info.currency} · installation currency</span>}</header>
    <nav className="erp-tabs" aria-label="ERP workspace sections">{workspaceTabs.map((item) => <a key={item.entity} data-erp-tab="true" href={`?erpTab=${item.entity}`} aria-current={tab === item.entity ? 'page' : undefined} onClick={(event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (allowLeave()) navigate(item.entity);
    }}>{item.label}</a>)}</nav>
    <Failure error={error} retry={() => setRetry((value) => value + 1)} />
    {!info && !error && <p role="status">Loading workspace configuration…</p>}
    {info && (tab === 'accounting' ? info.accounting ? <AccountingWorkspace onBlock={onBlock} onLoading={onLoading} allowLeave={allowLeave} /> : <p className="erp-notice">Accounting requires the paired Node host and a VND installation. It is unavailable on this host; CRM and sales remain available.</p> : selection ? <RecordPanel key={selection.key} selection={selection} info={info} onBlock={onBlock} onLoading={onLoading} allowLeave={allowLeave} onChanged={() => setRefresh((value) => value + 1)} onRelated={openRelated} onClose={() => {
      if (!allowLeave()) return;
      setSelection(undefined);
      block.current = { dirty: false, pending: false };
      window.requestAnimationFrame(() => root.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]')?.focus());
    }} /> : <RecordList key={tab} entity={tab} info={info} refresh={refresh} onOpen={(id) => setSelection({ entity: tab, id, creating: false, key: crypto.randomUUID() })} onCreate={() => setSelection({ entity: tab, id: crypto.randomUUID(), creating: true, key: crypto.randomUUID() })} />)}
    <footer className="erp-footer">Private administrator workspace · {info?.accounting ? 'Internal VND bookkeeping; no statutory accounting, tax or inventory ledger.' : 'CRM and sales. Accounting is unavailable on this host.'}</footer>
  </div>;
}

export const pages: PluginAdminExports['pages'] = { '/workspace': Workspace };
