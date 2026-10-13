import { useState } from 'react';
import type { Journal, SettlementInput } from '../../accounting/model.js';
import type { RecordView } from '../../model.js';
import { accountingRequest } from '../api.js';
import { Failure, Field, useEditorBlock, useMutation } from '../shared.js';
import type { EditorProps } from '../shared.js';
import { AllocationEditor, allocationInputs, MasterPicker, vnd } from './shared.js';
import type { AllocationForm } from './shared.js';

export function SettlementEditor({ id, record, kind, startDate, onSaved, onBlock, onReload, onOpenJournal }: EditorProps & {
  id: string; record?: RecordView<Journal>; kind: 'receipt' | 'payment'; startDate: string; onSaved: (value: RecordView<Journal>) => void; onOpenJournal: (id: string) => void;
}) {
  const money = record?.value.lines.find((line) => line.account?.purpose === 'cash' || line.account?.purpose === 'bank');
  const control = record?.value.lines.find((line) => line.partyId && line.allocations.length);
  const [form, setForm] = useState(() => ({ revision: record?.revision ?? null, postingDate: record?.value.postingDate ?? '', memo: record?.value.memo ?? '', reference: record?.value.reference ?? '', moneyAccountId: money?.accountId ?? '', partyId: control?.partyId ?? '', controlAccountId: control?.accountId }));
  const [allocations, setAllocations] = useState<AllocationForm[]>(() => record?.value.lines.flatMap((line) => line.allocations.map((value) => ({ ...value, text: String(value.amountMinor) }))) ?? []);
  const [dirty, setDirty] = useState(false);
  const mutation = useMutation();
  useEditorBlock(dirty, mutation.pending, onBlock);
  let total = 0n;
  for (const value of allocations) if (/^\d+$/.test(value.text)) total += BigInt(value.text);
  const accountId = allocations[0]?.source?.accountId ?? form.controlAccountId;
  return <form onSubmit={(event) => {
    event.preventDefault();
    try {
      if (!form.moneyAccountId || !form.partyId) throw new Error('Choose an active cash/bank account and the correct party.');
      if (!allocations.length || allocations.length > 49) throw new Error('Choose 1–49 sources.');
      const values = allocationInputs(allocations);
      const amount = values.reduce((sum, value) => sum + BigInt(value.amountMinor), 0n);
      if (amount > 1_000_000_000_000n) throw new Error('The single money-account line cannot exceed VND 1,000,000,000,000.');
      const input: SettlementInput = { id, revision: form.revision, kind, postingDate: form.postingDate, memo: form.memo, reference: form.reference, moneyAccountId: form.moneyAccountId, partyId: form.partyId, allocations: values };
      void mutation.run(() => accountingRequest<RecordView<Journal>>('save-settlement', input), onSaved);
    } catch (cause) { mutation.setError(cause); }
  }}>
    <Failure error={mutation.error} />
    <p className="erp-muted">{kind === 'receipt' ? 'Receipt: debit cash/bank, credit customer receivable.' : 'Payment: debit supplier payable, credit cash/bank.'} Choose posted sources from the same control account and party. Save creates only a draft; posting remains a separate explicit action.</p>
    <fieldset className="erp-fieldset" disabled={mutation.pending}><legend>{kind === 'receipt' ? 'Receipt' : 'Payment'} details</legend><div className="erp-form-grid">
      <Field label="Posting date"><input required type="date" min={startDate} value={form.postingDate} onChange={(event) => { setForm({ ...form, postingDate: event.target.value }); setDirty(true); }} /></Field>
      <Field label="Internal reference"><input maxLength={200} value={form.reference} onChange={(event) => { setForm({ ...form, reference: event.target.value }); setDirty(true); }} /></Field>
    </div><Field label="Memo"><textarea maxLength={2000} value={form.memo} onChange={(event) => { setForm({ ...form, memo: event.target.value }); setDirty(true); }} /></Field>
      <MasterPicker entity="accounts" label="Money account" value={form.moneyAccountId} accept={(value) => 'purpose' in value && !value.isGroup && (value.purpose === 'cash' || value.purpose === 'bank')} onChange={(moneyAccountId) => { setForm({ ...form, moneyAccountId }); setDirty(true); }} />
      <MasterPicker entity="parties" label={kind === 'receipt' ? 'Customer party' : 'Supplier party'} value={form.partyId} kind={kind === 'receipt' ? 'customer' : 'supplier'} onChange={(partyId) => { setForm({ ...form, partyId, controlAccountId: undefined }); setAllocations([]); setDirty(true); }} />
      <AllocationEditor accountId={accountId} partyId={form.partyId} values={allocations} max={49} onOpenJournal={onOpenJournal} onChange={(values) => { setAllocations(values); setDirty(true); }} />
      <p role="status">Draft total {vnd(total)} · {allocations.length} source lines + 1 money line</p>
    </fieldset>
    <div className="erp-savebar"><button type="submit" className="erp-primary" disabled={mutation.pending}>{mutation.pending ? 'Saving…' : 'Save settlement draft'}</button><span>{dirty ? 'Unsaved changes' : 'No unsaved changes'}</span>{record && <><button type="button" disabled={mutation.pending} onClick={onReload}>Reload saved journal</button><button type="button" disabled={mutation.pending} onClick={() => { if (!window.confirm('Reload only the latest revision, retaining edits?')) return; void mutation.run(() => accountingRequest<RecordView<Journal>>('get', { entity: 'journals', id }), (value) => { if (value.value.status !== 'draft') { mutation.setError(new Error('This journal is no longer a draft; reload history. Your input is retained.')); return; } setForm((current) => ({ ...current, revision: value.revision })); setDirty(true); }); }}>Reload revision, retain edits</button></>}</div>
  </form>;
}
