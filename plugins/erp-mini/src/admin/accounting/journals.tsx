import { useState } from 'react';
import type { AccountPurpose, Journal, JournalInput, JournalLineInput } from '../../accounting/model.js';
import type { RecordView } from '../../model.js';
import { accountingRequest } from '../api.js';
import { Failure, Field, useEditorBlock, useMutation } from '../shared.js';
import type { EditorProps } from '../shared.js';
import type { FinancialCommands } from './intent.js';
import { AllocationEditor, allocationInputs, dong, MasterPicker, vnd } from './shared.js';
import type { AllocationForm } from './shared.js';

type LineForm = { key: string; accountId: string; partyId: string; purpose?: AccountPurpose; debit: string; credit: string; allocations: AllocationForm[] };
export function JournalEditor({ id, record, kind = 'journal', startDate, onSaved, onBlock, onReload, onOpenJournal }: EditorProps & {
  id: string; record?: RecordView<Journal>; kind?: 'journal' | 'opening'; startDate: string; onSaved: (record: RecordView<Journal>) => void; onOpenJournal: (id: string) => void;
}) {
  const [header, setHeader] = useState(() => ({ revision: record?.revision ?? null, kind: record?.value.kind === 'opening' ? 'opening' as const : kind, postingDate: record?.value.postingDate ?? (kind === 'opening' ? startDate : ''), memo: record?.value.memo ?? '', reference: record?.value.reference ?? '' }));
  const [lines, setLines] = useState<LineForm[]>(() => record?.value.lines.map((value) => ({ key: crypto.randomUUID(), accountId: value.accountId, partyId: value.partyId ?? '', purpose: value.account?.purpose, debit: String(value.debitMinor), credit: String(value.creditMinor), allocations: value.allocations.map((allocation) => ({ ...allocation, text: String(allocation.amountMinor) })) })) ?? Array.from({ length: 2 }, () => ({ key: crypto.randomUUID(), accountId: '', partyId: '', debit: '0', credit: '0', allocations: [] })));
  const [dirty, setDirty] = useState(false);
  const mutation = useMutation();
  useEditorBlock(dirty, mutation.pending, onBlock);
  function changeLine(index: number, values: Partial<LineForm>) { setLines((current) => current.map((value, position) => position === index ? { ...value, ...values } : value)); setDirty(true); }
  let debit = 0n; let credit = 0n; let validAmounts = true;
  for (const line of lines) { if (/^\d+$/.test(line.debit) && /^\d+$/.test(line.credit)) { debit += BigInt(line.debit); credit += BigInt(line.credit); } else validAmounts = false; }
  const balanced = validAmounts && debit > 0n && debit === credit;
  return <form onSubmit={(event) => {
    event.preventDefault();
    try {
      const inputs: JournalLineInput[] = lines.map((line, index) => {
        if (!line.accountId) throw new Error(`Choose an account for line ${index + 1}.`);
        const debitMinor = dong(line.debit); const creditMinor = dong(line.credit);
        if ((debitMinor > 0) === (creditMinor > 0)) throw new Error(`Line ${index + 1} must have exactly one positive side.`);
        const allocations = allocationInputs(line.allocations);
        if (allocations.length && allocations.reduce((sum, value) => sum + BigInt(value.amountMinor), 0n) !== BigInt(debitMinor || creditMinor)) throw new Error(`Line ${index + 1} must be fully allocated.`);
        return { accountId: line.accountId, partyId: line.partyId || null, debitMinor, creditMinor, allocations };
      });
      if (!balanced) throw new Error('Total debit must equal total credit and be positive.');
      const input: JournalInput = { id, ...header, lines: inputs };
      void mutation.run(() => accountingRequest<RecordView<Journal>>('save-journal', input), onSaved);
    } catch (cause) { mutation.setError(cause); }
  }}>
    <Failure error={mutation.error} />
    <p className="erp-muted">Saving a draft never changes ledger or debt. Posting requires a separate review and confirmation. Opening entries use the book start date, chosen accounts and actual operator-provided balances.</p>
    <fieldset disabled={mutation.pending} className="erp-fieldset"><legend>{header.kind === 'opening' ? 'Opening journal' : 'Journal'} header</legend><div className="erp-form-grid">
      <Field label="Posting date"><input type="date" required min={startDate} readOnly={header.kind === 'opening'} value={header.postingDate} onChange={(event) => { setHeader({ ...header, postingDate: event.target.value }); setDirty(true); }} /></Field>
      <Field label="Internal reference"><input maxLength={200} value={header.reference} onChange={(event) => { setHeader({ ...header, reference: event.target.value }); setDirty(true); }} /></Field>
    </div><Field label="Memo"><textarea maxLength={2000} value={header.memo} onChange={(event) => { setHeader({ ...header, memo: event.target.value }); setDirty(true); }} /></Field></fieldset>
    <fieldset disabled={mutation.pending} className="erp-fieldset"><legend>Journal lines · {lines.length}/50</legend>
      {lines.map((line, index) => <section className="erp-contact" key={line.key}><h3>Line {index + 1}</h3>
        <MasterPicker entity="accounts" label={`Account · line ${index + 1}`} value={line.accountId} accept={(value) => 'isGroup' in value && !value.isGroup} onChange={(accountId, entry) => changeLine(index, { accountId, purpose: entry && 'purpose' in entry.value ? entry.value.purpose : undefined, partyId: '', allocations: [] })} />
        <MasterPicker entity="parties" label={`Party · line ${index + 1}`} optional value={line.partyId} kind={line.purpose === 'receivable' ? 'customer' : line.purpose === 'payable' ? 'supplier' : undefined} onChange={(partyId) => changeLine(index, { partyId, allocations: [] })} />
        <div className="erp-form-grid"><Field label={`Debit · line ${index + 1}`} hint="Whole dong, 0–1,000,000,000,000; no separators."><input required inputMode="numeric" maxLength={13} value={line.debit} onChange={(event) => changeLine(index, { debit: event.target.value })} /></Field><Field label={`Credit · line ${index + 1}`}><input required inputMode="numeric" maxLength={13} value={line.credit} onChange={(event) => changeLine(index, { credit: event.target.value })} /></Field></div>
        {line.partyId && <details open={Boolean(line.allocations.length)}><summary>Per-source debt allocations · line {index + 1}</summary><p>Required for receivable credit / payable debit. Receivable debit / payable credit creates a new source and must not allocate.</p><AllocationEditor accountId={line.accountId || undefined} partyId={line.partyId} values={line.allocations} onChange={(allocations) => changeLine(index, { allocations })} onOpenJournal={onOpenJournal} /></details>}
        <button type="button" disabled={lines.length <= 2} onClick={() => { setLines(lines.filter((_, position) => position !== index)); setDirty(true); }}>Remove line {index + 1}</button>
      </section>)}
      <button type="button" disabled={lines.length >= 50} onClick={() => { setLines([...lines, { key: crypto.randomUUID(), accountId: '', partyId: '', debit: '0', credit: '0', allocations: [] }]); setDirty(true); }}>Add journal line</button>
    </fieldset>
    <p role="status">Debit {vnd(debit)} · Credit {vnd(credit)} · {balanced ? 'Balanced' : 'Not balanced'}{validAmounts ? ` · Difference ${vnd(debit - credit)}` : ' · Invalid whole-dong input'}</p>
    <div className="erp-savebar"><button className="erp-primary" type="submit" disabled={mutation.pending}>{mutation.pending ? 'Saving…' : 'Save draft'}</button><span>{dirty ? 'Unsaved changes' : 'No unsaved changes'}</span>{record && <><button type="button" disabled={mutation.pending} onClick={onReload}>Reload saved journal</button><button type="button" disabled={mutation.pending} onClick={() => { if (!window.confirm('Reload the latest revision and keep all local edits? Saving again will revalidate the entire journal.')) return; void mutation.run(() => accountingRequest<RecordView<Journal>>('get', { entity: 'journals', id }), (value) => { if (value.value.status !== 'draft') { mutation.setError(new Error('This journal is no longer a draft. Reload history; local edits are retained.')); return; } setHeader((current) => ({ ...current, revision: value.revision })); setDirty(true); }); }}>Reload revision, retain edits</button></>}</div>
  </form>;
}

export function JournalDetail({ record, startDate, onEdit, onSaved, onBlock, onOpenJournal, commands }: {
  record: RecordView<Journal>; startDate: string; onEdit: () => void; onSaved: (record: RecordView<Journal>) => void;
  onBlock: EditorProps['onBlock']; onOpenJournal: (id: string) => void; commands: FinancialCommands;
}) {
  const [reverse, setReverse] = useState(false);
  const [postingDate, setPostingDate] = useState('');
  const [memo, setMemo] = useState('');
  const mutation = useMutation();
  const journal = record.value;
  useEditorBlock(reverse && Boolean(postingDate || memo), mutation.pending, onBlock);
  return <section>
    <div className="erp-document-heading"><h3>{journal.number ?? 'Unposted draft'} · {journal.kind}</h3><span className="erp-status">{journal.status}{journal.reversedBy ? ' · reversed' : ''}</span></div>
    <dl><dt>Posting date / sequence</dt><dd>{journal.postingDate} · {journal.postedSequence ?? 'not posted'}</dd><dt>Reference</dt><dd>{journal.reference || '—'}</dd><dt>Memo</dt><dd className="erp-prewrap">{journal.memo}</dd><dt>Revision</dt><dd>{record.revision}</dd><dt>Posted by / at</dt><dd>{journal.postedBy ?? '—'} · {journal.postedAt ?? '—'}</dd></dl>
    {journal.reversalOf && <button type="button" onClick={() => onOpenJournal(journal.reversalOf!)}>View original journal</button>}{journal.reversedBy && <button type="button" onClick={() => onOpenJournal(journal.reversedBy!)}>View reversal journal</button>}
    <div className="erp-table-scroll" role="region" aria-label="Journal lines" tabIndex={0}><table><caption>Immutable snapshots after posting · VND whole dong</caption><thead><tr><th>Line / account</th><th>Party / role</th><th>Debit</th><th>Credit</th><th>Sources</th></tr></thead><tbody>{journal.lines.map((line) => <tr key={line.lineIndex}><th scope="row">{line.lineIndex + 1} · {line.account?.code ?? line.accountId}<small>{line.account?.name}</small></th><td>{line.party?.name ?? line.partyId ?? '—'}<small>{line.role}</small></td><td className="erp-numeric">{vnd(line.debitMinor)}</td><td className="erp-numeric">{vnd(line.creditMinor)}</td><td>{line.allocations.map((value) => <p key={`${value.sourceJournalId}:${value.sourceLineIndex}`}><button type="button" onClick={() => onOpenJournal(value.sourceJournalId)}>Source line {value.sourceLineIndex + 1}</button> {vnd(value.amountMinor)}</p>)}</td></tr>)}</tbody></table></div>
    <Failure error={mutation.error} />
    {journal.status === 'draft' && <div className="erp-actions"><button type="button" disabled={commands.blocked || mutation.pending} onClick={onEdit}>Edit draft</button><button className="erp-primary" type="button" disabled={commands.blocked || mutation.pending} onClick={() => { if (window.confirm(`Post this ${journal.kind} dated ${journal.postingDate}? It will become immutable and affect ledger/debt. Review all lines and allocations first.`)) void commands.execute({ action: 'post-journal', payload: { id: record.id, revision: record.revision, commandId: crypto.randomUUID() } }); }}>Post journal</button><button className="erp-danger" type="button" disabled={commands.blocked || mutation.pending} onClick={() => { if (window.confirm('Cancel this draft? History is retained; nothing is posted.')) void mutation.run(() => accountingRequest<RecordView<Journal>>('cancel-draft', { id: record.id, revision: record.revision }), onSaved); }}>Cancel draft</button></div>}
    {journal.status === 'posted' && !journal.reversalOf && !journal.reversedBy && <button type="button" disabled={commands.blocked || mutation.pending} onClick={() => setReverse(!reverse)}>{reverse ? 'Close reversal form' : 'Reverse journal'}</button>}
    {reverse && <form onSubmit={(event) => { event.preventDefault(); if (!window.confirm('Create and post a full reversal? This preserves original history, swaps every debit/credit and releases outgoing allocations. Active incoming settlements block the whole reversal.')) return; void commands.execute({ action: 'reverse-journal', payload: { id: record.id, revision: record.revision, commandId: crypto.randomUUID(), postingDate, memo } }); }}><fieldset disabled={commands.blocked || mutation.pending} className="erp-fieldset"><legend>Full reversal</legend><Field label="Reversal posting date"><input type="date" required min={journal.postingDate > startDate ? journal.postingDate : startDate} value={postingDate} onChange={(event) => setPostingDate(event.target.value)} /></Field><Field label="Reversal memo"><textarea required maxLength={2000} value={memo} onChange={(event) => setMemo(event.target.value)} /></Field><p className="erp-muted">Date must also be on or after the latest allocation/release of every affected source. Reverse settlements before reversing their source.</p><button className="erp-danger" type="submit">Confirm full reversal</button></fieldset></form>}
  </section>;
}
