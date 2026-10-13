import { useRef, useState } from 'react';
import type { FinancialResult, PostJournalInput, ReverseJournalInput } from '../../accounting/model.js';
import { financialResultSchema, postJournalSchema, reverseJournalSchema } from '../../accounting/validation.js';
import { accountingRequest, RequestError } from '../api.js';
import { Failure } from '../shared.js';

type FinancialIntent = { action: 'post-journal'; payload: PostJournalInput } | { action: 'reverse-journal'; payload: ReverseJournalInput };
export type FinancialCommands = { blocked: boolean; execute: (intent: FinancialIntent) => Promise<void> };
export interface FinancialIntentState extends FinancialCommands { intent: FinancialIntent | undefined; error: unknown; pending: boolean; retry: () => Promise<void> }

/** Persist only the exact command intent, never a business-record cache. */
export function useFinancialIntent(installationId: string, onResult: (result: FinancialResult) => void): FinancialIntentState {
  const key = `erp-mini:accounting:${installationId}:financial-intent`;
  const [initial] = useState(() => {
    try {
      const raw = window.sessionStorage.getItem(key);
      if (!raw) return { intent: undefined as FinancialIntent | undefined, error: undefined as unknown };
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 || !('action' in value) || !('payload' in value) || (value.action !== 'post-journal' && value.action !== 'reverse-journal')) throw new Error('Stored financial intent is invalid. Preserve this session and contact the installation operator; do not issue a replacement command.');
      const schema = value.action === 'post-journal' ? postJournalSchema : reverseJournalSchema;
      if (!schema.safeParse(value.payload).success) throw new Error('Stored financial intent is invalid. Preserve this session and contact the installation operator; no command was sent.');
      // Validate without normalizing: retries must retain the exact persisted payload.
      return { intent: value as FinancialIntent, error: undefined as unknown };
    } catch (error) { return { intent: undefined as FinancialIntent | undefined, error }; }
  });
  const [intent, setIntent] = useState(initial.intent);
  const [error, setError] = useState<unknown>(initial.error);
  const [pending, setPending] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(Boolean(initial.error));
  const lock = useRef(false);
  const current = useRef(initial.intent);
  async function submit(command: FinancialIntent) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(undefined);
    try {
      const acknowledgment = financialResultSchema.safeParse(await accountingRequest<unknown>(command.action, command.payload));
      if (!acknowledgment.success ||
        (command.action === 'post-journal' && acknowledgment.data.id !== command.payload.id.toLowerCase()) ||
        (command.action === 'reverse-journal' && acknowledgment.data.id === command.payload.id.toLowerCase())) {
        throw new Error('The financial acknowledgment is invalid. Preserve the exact intent and reconcile the same command; do not issue a replacement.');
      }
      window.sessionStorage.removeItem(key);
      current.current = undefined; setIntent(undefined); setStorageBlocked(false);
      onResult(acknowledgment.data);
    } catch (cause) {
      // Commit failures and receipt ownership conflicts cannot prove non-commit.
      if (cause instanceof RequestError && cause.code !== 'INTERNAL_ERROR' && cause.code !== 'IDEMPOTENCY_CONFLICT') {
        try { window.sessionStorage.removeItem(key); current.current = undefined; setIntent(undefined); } catch { setStorageBlocked(true); }
      }
      setError(cause);
    } finally { lock.current = false; setPending(false); }
  }
  async function execute(command: FinancialIntent) {
    if (current.current || storageBlocked || lock.current) return;
    try {
      window.sessionStorage.setItem(key, JSON.stringify(command));
      current.current = command; setIntent(command);
    } catch (cause) { setError(new Error(`Financial command was not sent: durable session intent storage is unavailable. ${cause instanceof Error ? cause.message : ''}`)); return; }
    await submit(command);
  }
  return { blocked: Boolean(intent) || storageBlocked || pending, intent, error, pending, execute, retry: async () => { if (current.current) await submit(current.current); } };
}

export function FinancialIntentNotice({ state }: { state: FinancialIntentState }) {
  return <><Failure error={state.error} />{state.intent && <section className="erp-notice" aria-label="Unresolved financial intent">
    <h3>Financial result is not yet reconciled</h3>
    <p>{state.intent.action} · journal {state.intent.payload.id} · command {state.intent.payload.commandId}</p>
    <p>The exact submitted payload is retained in this installation’s session storage, including across page reload. Editing and navigation are locked. Retry reconciles the same command receipt; it never uses a fresh UUID. Do not start another tab to replace this intent.</p>
    {state.error instanceof RequestError && state.error.code === 'IDEMPOTENCY_CONFLICT' && <p>The command may already have committed under its original actor or payload. Sign back in as the original actor without changing the stored intent. If the conflict persists, preserve this session and contact the installation operator.</p>}
    <button type="button" disabled={state.pending} onClick={() => void state.retry()}>{state.pending ? 'Reconciling…' : 'Retry / reconcile exact command'}</button>
  </section>}</>;
}
