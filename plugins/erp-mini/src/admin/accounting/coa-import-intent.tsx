import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import type { CoaImportInput, CoaImportResult } from '../../accounting/model.js';
import { coaImportResultSchema, coaImportSchema } from '../../accounting/validation.js';
import { accountingRequest, RequestError } from '../api.js';
import { Failure } from '../shared.js';

export interface CoaImportIntent { payload: CoaImportInput; expectedCodes: string[] }
export interface CoaImportIntentState {
  blocked: boolean;
  pending: boolean;
  error: unknown;
  intent: CoaImportIntent | undefined;
  failureGeneration: number;
  execute: (payload: CoaImportInput, expectedCodes: string[]) => Promise<void>;
  retry: () => Promise<void>;
}

const intentSchema = z.strictObject({
  payload: coaImportSchema,
  expectedCodes: z.array(z.string().regex(/^[0-9]{3,6}$/)).min(1).max(512),
}).superRefine((intent, context) => {
  const codes = new Set(intent.expectedCodes);
  if (codes.size !== intent.expectedCodes.length || intent.payload.selectedCodes.some((code) => !codes.has(code))) {
    context.addIssue({ code: 'custom', message: 'Danh sách tài khoản dự kiến không khớp lựa chọn.' });
  }
});

// These responses explicitly reject this import before any account can commit.
// Storage, busy, record corruption, authentication and transport errors are not evidence of non-commit.
const noncommitCodes: Record<string, true | undefined> = { INVALID_INPUT: true, COA_TEMPLATE_VERSION: true, COA_IMPORT_CONFLICT: true };
interface SessionState {
  key: string;
  intent: CoaImportIntent | undefined;
  error: unknown;
  pending: boolean;
  storageBlocked: boolean;
  failureGeneration: number;
}
function restore(key: string): SessionState {
  const state: SessionState = { key, intent: undefined, error: undefined, pending: false, storageBlocked: false, failureGeneration: 0 };
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return state;
    const value: unknown = JSON.parse(raw);
    if (!intentSchema.safeParse(value).success) throw new Error('Lệnh nhập đã lưu không hợp lệ. Giữ nguyên phiên này và liên hệ người vận hành; không xóa lệnh hoặc tạo lệnh thay thế.');
    // Check syntax only, without applying transforms or consulting today's catalog.
    state.intent = value as CoaImportIntent;
  } catch (cause) {
    state.storageBlocked = true;
    state.error = new Error(`Không thể khôi phục lệnh nhập từ bộ nhớ phiên. Giữ nguyên phiên này và liên hệ người vận hành; không tạo lệnh thay thế. ${cause instanceof Error ? cause.message : ''}`);
  }
  return state;
}
function sameCodes(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((code, index) => code === sortedRight[index]);
}

/** Installation-scoped exact command recovery, independent of journal receipts and posting sequences. */
export function useCoaImportIntent(installationId: string, onResult: (result: CoaImportResult) => void): CoaImportIntentState {
  const key = `erp-mini:accounting:${installationId}:coa-import-intent`;
  const [snapshot, setSnapshot] = useState(() => restore(key));
  const current = useRef(snapshot);
  const activeKey = useRef(key);
  activeKey.current = key;
  const resultCallback = useRef(onResult);
  resultCallback.current = onResult;
  useEffect(() => {
    if (current.current.key !== key) {
      current.current = restore(key);
      setSnapshot(current.current);
    }
  }, [key]);
  function publish(session: SessionState) {
    if (current.current !== session) return;
    setSnapshot({ ...session });
  }
  function removeIntent(session: SessionState) {
    try {
      const saved = window.sessionStorage.getItem(session.key);
      if (saved !== null && saved !== JSON.stringify(session.intent)) throw new Error('Lệnh trong bộ nhớ phiên đã thay đổi; không được xóa lệnh khác.');
      window.sessionStorage.removeItem(session.key);
      if (window.sessionStorage.getItem(session.key) !== null) throw new Error('Lệnh vẫn còn trong bộ nhớ phiên.');
      session.intent = undefined;
      session.storageBlocked = false;
    } catch (cause) {
      session.storageBlocked = true;
      throw new Error(`Không thể xóa lệnh nhập đã lưu sau khi đối soát. Lệnh gốc vẫn bị khóa; thử đối soát lại cùng mã lệnh, không tạo mã mới. ${cause instanceof Error ? cause.message : ''}`);
    }
  }
  async function submit(session: SessionState) {
    if (current.current !== session || session.key !== activeKey.current || session.pending || !session.intent) return;
    const command = session.intent;
    session.pending = true;
    session.error = undefined;
    publish(session);
    let result: CoaImportResult | undefined;
    try {
      try {
        const serialized = JSON.stringify(command);
        const saved = window.sessionStorage.getItem(session.key);
        if (saved !== null && saved !== serialized) throw new Error('Bộ nhớ phiên chứa lệnh khác hoặc đã bị sửa; không được ghi đè.');
        if (saved === null) window.sessionStorage.setItem(session.key, serialized);
        if (window.sessionStorage.getItem(session.key) !== serialized) throw new Error('Không đọc lại được lệnh chính xác vừa lưu.');
        session.storageBlocked = false;
      } catch (cause) {
        session.storageBlocked = true;
        throw new Error(`Chưa gửi lệnh nhập lần này: không xác nhận được lệnh chính xác trong bộ nhớ phiên. Giữ nguyên trang này; tải lại khi chưa lưu được có thể mất lệnh. Lựa chọn bị khóa để không tạo lệnh thay thế. Thử lại chỉ lưu và gửi cùng lệnh gốc. ${cause instanceof Error ? cause.message : ''}`);
      }
      const acknowledgment = coaImportResultSchema.safeParse(await accountingRequest<unknown>('import-accounts', command.payload));
      // A stale installation's response must leave its saved intent available for recovery.
      if (current.current !== session || session.key !== activeKey.current) return;
      if (!acknowledgment.success || acknowledgment.data.commandId !== command.payload.commandId.toLowerCase() ||
          acknowledgment.data.templateId !== command.payload.templateId || acknowledgment.data.templateVersion !== command.payload.templateVersion ||
          !sameCodes(acknowledgment.data.selectedCodes, command.payload.selectedCodes) ||
          !sameCodes([...acknowledgment.data.created, ...acknowledgment.data.existing].map((account) => account.code), command.expectedCodes)) {
        throw new Error('Biên nhận nhập tài khoản không hợp lệ hoặc không khớp lệnh và toàn bộ mã dự kiến. Giữ nguyên lệnh; thử đối soát cùng mã lệnh, không tạo lệnh thay thế.');
      }
      removeIntent(session);
      result = acknowledgment.data;
    } catch (cause) {
      if (current.current !== session || session.key !== activeKey.current) return;
      if (cause instanceof RequestError && Object.hasOwn(noncommitCodes, cause.code)) {
        try {
          removeIntent(session);
          session.failureGeneration += 1;
          session.error = cause;
        } catch (storageCause) { session.error = storageCause; }
      } else { session.error = cause; }
    } finally {
      session.pending = false;
      publish(session);
    }
    // UI refresh failures must never be interpreted as an unacknowledged server command.
    if (result && current.current === session && session.key === activeKey.current) resultCallback.current(result);
  }
  async function execute(payload: CoaImportInput, expectedCodes: string[]) {
    const session = current.current;
    if (session.key !== key || session.key !== activeKey.current || session.intent || session.storageBlocked || session.pending) return;
    if (!intentSchema.safeParse({ payload, expectedCodes }).success) {
      session.error = new Error('Lệnh nhập hoặc danh sách mã dự kiến không hợp lệ. Xem trước lại trước khi nhập. Chưa gửi lệnh.');
      session.failureGeneration += 1;
      publish(session);
      return;
    }
    // Do not overwrite an intent that appeared since mount (e.g. another workspace mounted in this tab).
    const saved = restore(key);
    if (saved.intent || saved.storageBlocked) {
      saved.failureGeneration = session.failureGeneration;
      if (saved.intent) saved.error = new Error('Đã có lệnh nhập chưa đối soát trong bộ nhớ phiên. Khôi phục và thử lại lệnh gốc; không gửi lựa chọn mới.');
      current.current = saved;
      publish(saved);
      return;
    }
    // Snapshot caller-owned arrays without normalizing the exact request used for every retry.
    session.intent = JSON.parse(JSON.stringify({ payload, expectedCodes })) as CoaImportIntent;
    publish(session);
    await submit(session);
  }
  const scoped = snapshot.key === key;
  return {
    blocked: !scoped || Boolean(snapshot.intent) || snapshot.storageBlocked || snapshot.pending,
    pending: scoped && snapshot.pending,
    error: scoped ? snapshot.error : undefined,
    intent: scoped ? snapshot.intent : undefined,
    failureGeneration: scoped ? snapshot.failureGeneration : 0,
    execute,
    retry: async () => { if (current.current.key === key) await submit(current.current); },
  };
}

export function CoaImportIntentNotice({ state }: { state: CoaImportIntentState }) {
  const heading = useId();
  const focus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.error || state.intent) focus.current?.focus();
  }, [state.error, state.intent]);
  if (!state.error && !state.intent && !state.blocked) return null;
  return <div ref={focus} tabIndex={-1} aria-label="Thông báo nhập tài khoản">
    <Failure error={state.error} />
    {state.blocked && <section className="erp-notice" aria-labelledby={heading} aria-busy={state.pending}>
      <h3 id={heading}>Chưa xác nhận kết quả nhập</h3>
      {state.intent && <p>{state.intent.payload.templateId} · phiên bản {state.intent.payload.templateVersion} · mã lệnh {state.intent.payload.commandId}</p>}
      <p>Không thể coi lỗi mạng, lỗi máy chủ hay biên nhận sai là bằng chứng lệnh chưa được ghi nhận. Lựa chọn mới và thao tác sửa bị khóa cho đến khi đối soát lệnh gốc. Không mở tab mới, xóa bộ nhớ phiên hoặc đổi mã lệnh để nhập lại.</p>
      {state.intent && <p>Lệnh chính xác và danh sách mã dự kiến được giữ nguyên. Khi lưu bộ nhớ phiên thành công, lệnh được khôi phục sau khi tải lại trang, kể cả khi bảng nhập đã đóng. Thử lại đối soát cùng mã lệnh, không dùng UUID mới.</p>}
      {state.error instanceof RequestError && state.error.code === 'IDEMPOTENCY_CONFLICT' && <p>Lệnh có thể đã được ghi nhận dưới người thực hiện hoặc nội dung gốc. Đăng nhập lại bằng tài khoản đã gửi lệnh ban đầu, không thay đổi lệnh đã lưu. Nếu vẫn xung đột, giữ nguyên phiên này và liên hệ người vận hành.</p>}
      {!state.intent && <p>Không đọc được lệnh gốc từ bộ nhớ phiên. Giữ nguyên phiên này và liên hệ người vận hành để khôi phục; không có lệnh nào được gửi lại tự động.</p>}
      {state.intent && <button type="button" disabled={state.pending} onClick={() => void state.retry()}>{state.pending ? 'Đang đối soát…' : 'Thử lại / đối soát lệnh gốc'}</button>}
      <p role="status" aria-live="polite">{state.pending ? 'Đang gửi và đối soát cùng mã lệnh.' : 'Chờ đối soát lệnh nhập gốc.'}</p>
    </section>}
    {Boolean(state.error) && !state.blocked && state.failureGeneration > 0 && <p role="status">Lệnh đã bị từ chối trước khi ghi nhận tài khoản. Xem trước lại lựa chọn hiện tại trước khi xác nhận nhập.</p>}
  </div>;
}
