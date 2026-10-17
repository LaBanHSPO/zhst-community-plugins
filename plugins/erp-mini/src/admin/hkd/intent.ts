import { useRef, useState } from 'react';
import { z } from 'zod';
import type { HkdCommandResult, HkdConfigureInput, HkdPostInput, HkdVoidInput } from '../../accounting/hkd-model.js';
import { hkdConfigureSchema, hkdPostSchema, hkdProfileSchema, hkdEntrySchema, hkdVoidSchema } from '../../accounting/hkd-validation.js';
import { accountingRequest, RequestError } from '../api.js';

type Command = { action: 'hkd-configure'; payload: HkdConfigureInput } | { action: 'hkd-post-entry'; payload: HkdPostInput } | { action: 'hkd-void-entry'; payload: HkdVoidInput };
type Intent = { key: string; command: Command };
export interface HkdIntentState {
  intent?: Intent; error?: unknown; locked: boolean; pending: boolean;
  execute: (command: Command, installationId?: string) => Promise<void>;
  retry: () => Promise<void>;
}
const registry = 'erp-mini:hkd:unresolved:v1'; // sessionStorage is already origin-scoped; survives initial configure/reload.
const uuid = z.string().uuid();
const stamp = z.string().datetime();
const entrySchema = z.strictObject({ id: uuid, year: z.number().int(), sequence: z.number().int().positive(), createdAt: stamp, createdBy: z.string().min(1), entry: hkdEntrySchema, voided: z.boolean(), voidReason: z.string().nullable() });
const receiptSchema = z.strictObject({ commandId: uuid, action: z.enum(['hkd-configure', 'hkd-post-entry', 'hkd-void-entry']), year: z.number().int(), profile: hkdProfileSchema.optional(), entry: entrySchema.optional(), voidedId: uuid.optional(), asOfSequence: z.number().int().nonnegative() });
// A missing/mismatched profile may be a replaced resource after an earlier commit.
// Keep the original command until the operator restores the resource for reconciliation.
const noncommit = new Set(['INVALID_INPUT', 'CONFLICT', 'INVALID_TRANSITION', 'HKD_BOOK_UNAVAILABLE', 'HKD_NEGATIVE_STOCK', 'HKD_NEGATIVE_MONEY', 'HKD_OPENING_REQUIRED', 'HKD_IDENTITY_CONFLICT']);
function canonical(command: Command): Command {
  if (command.action === 'hkd-configure') return { action: command.action, payload: hkdConfigureSchema.parse(command.payload) };
  if (command.action === 'hkd-post-entry') return { action: command.action, payload: hkdPostSchema.parse(command.payload) };
  return { action: command.action, payload: hkdVoidSchema.parse(command.payload) };
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = Object.keys(left).sort(), b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index] && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
function verify(value: unknown, command: Command): HkdCommandResult {
  const receipt = receiptSchema.parse(value);
  const expected = canonical(command);
  if (receipt.commandId !== expected.payload.commandId || receipt.action !== expected.action || receipt.year !== expected.payload.year) throw new Error('Biên nhận không khớp mã lệnh, thao tác hoặc năm.');
  if (expected.action === 'hkd-configure') {
    if (!receipt.profile || receipt.entry || receipt.voidedId) throw new Error('Biên nhận thiết lập không hợp lệ.');
    const { commandId: _, ...policy } = expected.payload;
    const { installationId: _i, revision: _r, createdAt: _a, createdBy: _b, ...saved } = receipt.profile;
    if (!equal(policy, saved)) throw new Error('Chính sách trong biên nhận không khớp lệnh thiết lập.');
  } else if (expected.action === 'hkd-post-entry') {
    if (!receipt.entry || receipt.profile || receipt.voidedId || receipt.entry.year !== expected.payload.year || receipt.entry.voided || receipt.entry.voidReason !== null || receipt.entry.sequence !== receipt.asOfSequence) throw new Error('Biên nhận ghi sổ không hợp lệ.');
    const parsed = hkdPostSchema.parse({ ...expected.payload, entry: receipt.entry.entry });
    if (!equal(parsed.entry, expected.payload.entry)) throw new Error('Nội dung ghi sổ trong biên nhận không khớp lệnh gốc.');
  } else if (receipt.voidedId !== expected.payload.id || receipt.profile || receipt.entry || receipt.asOfSequence === 0) throw new Error('Biên nhận hủy không khớp chứng từ.');
  return receipt as HkdCommandResult;
}
function restore(): { intent?: Intent; error?: unknown; locked: boolean } {
  try {
    const raw = sessionStorage.getItem(registry);
    if (raw === null) return { locked: false };
    const value = JSON.parse(raw) as Intent;
    if (!value.key.startsWith('erp-mini:hkd:') || value.key === registry || !['hkd-configure', 'hkd-post-entry', 'hkd-void-entry'].includes(value.command.action)) throw new Error('Lệnh khôi phục không hợp lệ.');
    const scoped = sessionStorage.getItem(value.key);
    if (scoped !== null && scoped !== raw) throw new Error('Hai bản lệnh khôi phục không khớp; không ghi đè.');
    canonical(value.command);
    return { intent: value, locked: true };
  } catch (error) { return { locked: true, error }; }
}
export function useHkdIntent(onResult: (result: HkdCommandResult) => void): HkdIntentState {
  const [state, setState] = useState(restore);
  const [pending, setPending] = useState(false);
  const current = useRef(state); const sending = useRef(false); const callback = useRef(onResult); callback.current = onResult;
  function publish(next: typeof state) { current.current = next; setState(next); }
  function clear(intent: Intent) {
    const encoded = JSON.stringify(intent), scoped = sessionStorage.getItem(intent.key);
    if (sessionStorage.getItem(registry) !== encoded || (scoped !== null && scoped !== encoded)) throw new Error('Bộ nhớ phiên đã thay đổi; giữ lệnh gốc để đối soát.');
    // The stable registry holds the full command until both scoped cleanup and acknowledgment succeed.
    sessionStorage.removeItem(intent.key);
    if (sessionStorage.getItem(intent.key) !== null) throw new Error('Không thể xóa lệnh đã đối soát; thử lại cùng lệnh.');
    sessionStorage.removeItem(registry);
    if (sessionStorage.getItem(registry) !== null) throw new Error('Không thể xác nhận xóa khóa khôi phục.');
  }
  async function submit(intent: Intent) {
    if (sending.current) return;
    sending.current = true; setPending(true); publish({ intent, locked: true });
    let result: HkdCommandResult | undefined;
    try {
      const encoded = JSON.stringify(intent), saved = sessionStorage.getItem(intent.key), pointer = sessionStorage.getItem(registry);
      if ((pointer !== null && pointer !== encoded) || (saved !== null && saved !== encoded)) throw new Error('Đã có lệnh khác trong bộ nhớ phiên. Không ghi đè hoặc tạo mã mới.');
      sessionStorage.setItem(registry, encoded);
      sessionStorage.setItem(intent.key, encoded);
      if (sessionStorage.getItem(intent.key) !== encoded || sessionStorage.getItem(registry) !== encoded) throw new Error('Không lưu lại được chính xác lệnh. Chưa gửi lần này; giữ nguyên trang và thử lại.');
      result = verify(await accountingRequest<unknown>(intent.command.action, intent.command.payload), intent.command);
      clear(intent); publish({ locked: false });
    } catch (error) {
      result = undefined;
      if (error instanceof RequestError && noncommit.has(error.code)) {
        try { clear(intent); publish({ locked: false, error }); } catch (storageError) { publish({ locked: true, intent, error: storageError }); }
      } else publish({ locked: true, intent, error });
    } finally { sending.current = false; setPending(false); }
    if (result) callback.current(result);
  }
  async function execute(command: Command, installationId?: string) {
    if (current.current.locked || sending.current) return;
    let normalized: Command;
    try { normalized = canonical(command); } catch (error) { publish({ locked: false, error }); return; }
    const recovered = restore();
    if (recovered.locked) { publish(recovered); return; }
    const key = `erp-mini:hkd:${installationId ?? 'initial-origin'}:${normalized.payload.year}:command`;
    await submit({ key, command: normalized });
  }
  return { ...state, pending, execute, retry: () => current.current.intent ? submit(current.current.intent) : Promise.resolve() };
}
