import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Entity, ListPage } from '../model.js';
import { errorMessage, RequestError, request } from './api.js';

export type BlockState = { dirty: boolean; pending: boolean };
export type EditorProps = { onBlock: (state: BlockState) => void; onReload: () => void };

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="erp-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return <div className="erp-error" role="alert"><strong>Unable to complete the request</strong><p>{errorMessage(error)}</p>{error instanceof RequestError && error.code === 'CONFLICT' && <p>This record changed, or this creation already succeeded. Your input is preserved. Reload the saved record explicitly before editing again; no changes have been overwritten.</p>}{retry && <button type="button" onClick={retry}>Retry</button>}</div>;
}

export function useMutation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  async function run<T>(operation: () => Promise<T>, success: (value: T) => void) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try { success(await operation()); }
    catch (cause) { setError(cause); }
    finally { lock.current = false; setPending(false); }
  }
  return { pending, error, setError, run };
}

export function useEditorBlock(dirty: boolean, pending: boolean, onBlock: EditorProps['onBlock']) {
  useEffect(() => { onBlock({ dirty, pending }); }, [dirty, pending, onBlock]);
  useEffect(() => () => onBlock({ dirty: false, pending: false }), [onBlock]);
}

/** Only one bounded server page lives in memory; cursors are never interpreted. */
export function Paged<T>({ entity, search, active, children }: {
  entity: Entity; search?: string; active?: boolean;
  children: (page: ListPage<T>) => ReactNode;
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<ListPage<T>>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const cursor = cursors[pageIndex];
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPage(undefined);
    request<ListPage<T>>('list', { entity, search: search || undefined, active, cursor }, controller.signal).then(
      (data) => { setPage(data); setLoading(false); },
      (cause: unknown) => { if (!controller.signal.aborted) { setError(cause); setLoading(false); } },
    );
    return () => controller.abort();
  }, [entity, search, active, cursor, retry]);
  return <section aria-busy={loading} className="erp-results">
    {loading && <p role="status">Loading {entity === 'quotes' ? 'quotations' : entity}…</p>}
    <Failure error={error} retry={() => setRetry((value) => value + 1)} />
    {page && (page.items.length ? children(page) : <p className="erp-empty">{search ? `No names beginning with “${search}”. Change or clear your search.` : 'No records on this page. Create a record or adjust the filters.'}</p>)}
    <div className="erp-pagination" aria-label="Pagination">
      <button type="button" disabled={loading || pageIndex === 0} onClick={() => setPageIndex((index) => index - 1)}>Previous</button>
      <span>Page {pageIndex + 1}{page ? ` · ${page.items.length} shown` : ''}</span>
      <button type="button" disabled={loading || !page?.hasMore || !page.cursor} onClick={() => {
        if (!page?.cursor) return;
        setCursors((values) => [...values.slice(0, pageIndex + 1), page.cursor]);
        setPageIndex((index) => index + 1);
      }}>Next</button>
    </div>
  </section>;
}

export function Search({ value, onChange, label = 'Search by name' }: { value: string; onChange: (value: string) => void; label?: string }) {
  const id = useId();
  const [input, setInput] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => onChange(input.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [input, onChange]);
  return <div className="erp-search"><label htmlFor={id}>{label}</label><input id={id} type="search" value={input} maxLength={200} placeholder="Name begins with…" onChange={(event) => setInput(event.target.value)} /></div>;
}

export function SaveBar({ pending, dirty, existing, onReload }: { pending: boolean; dirty: boolean; existing: boolean; onReload: () => void }) {
  return <div className="erp-savebar"><button className="erp-primary" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save changes'}</button><span aria-live="polite">{dirty ? 'Unsaved changes' : 'No unsaved changes'}</span>{existing && <button type="button" disabled={pending} onClick={onReload}>Reload saved record</button>}</div>;
}
