import { useState } from 'react';
import type { RecordView } from '../../model.js';
import type { BookSettings } from '../../accounting/model.js';
import { accountingRequest } from '../api.js';
import { Failure, Field, useEditorBlock, useMutation } from '../shared.js';
import type { BlockState } from '../shared.js';

export function BookSetup({ onConfigured, onBlock, onReload }: { onConfigured: (book: RecordView<BookSettings>) => void; onBlock: (state: BlockState) => void; onReload: () => void }) {
  const [startDate, setStartDate] = useState('');
  const [dirty, setDirty] = useState(false);
  const mutation = useMutation();
  useEditorBlock(dirty, mutation.pending, onBlock);
  return <section className="erp-panel" aria-labelledby="accounting-setup-heading">
    <h2 id="accounting-setup-heading">Configure internal VND book</h2>
    <p>Choose the first date of this book. Currency is VND, with whole-dong amounts. Setup does not import sales, create accounts or guess opening balances. This is internal bookkeeping, not statutory accounting or tax certification.</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!window.confirm(`Create a VND book starting ${startDate}? The start date and currency cannot be edited afterwards.`)) return;
      void mutation.run(() => accountingRequest<RecordView<BookSettings>>('configure-book', { startDate }), (book) => { setDirty(false); onConfigured(book); });
    }}>
      <Failure error={mutation.error} />
      <fieldset className="erp-fieldset" disabled={mutation.pending}>
        <Field label="Book start date" hint="Operator-selected calendar date; no opening balances are created."><input type="date" required value={startDate} onChange={(event) => { setStartDate(event.target.value); setDirty(true); }} /></Field>
        <div className="erp-savebar"><button className="erp-primary" type="submit">{mutation.pending ? 'Configuring…' : 'Configure VND book'}</button><button type="button" onClick={onReload}>Reload book settings</button></div>
      </fieldset>
    </form>
  </section>;
}
