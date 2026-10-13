import { apiFetch, parseApiResponse } from 'emdash/plugin-utils';
import type { ApiResult, Currency } from '../model.js';
import type { AccountingAction } from '../accounting/model.js';

export class RequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

export async function request<T>(route: string, body?: unknown, signal?: AbortSignal, base = '/_emdash/api/plugins/erp-mini'): Promise<T> {
  const response = await apiFetch(`${base}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await parseApiResponse<ApiResult<T>>(response, 'ERP request failed');
  if (!result || typeof result.ok !== 'boolean' || (result.ok ? !('data' in result) : !result.error || typeof result.error.code !== 'string' || typeof result.error.message !== 'string')) throw new Error('The server returned an unexpected response. Reload and try again.');
  if (!result.ok) throw new RequestError(result.error.code, result.error.message);
  return result.data;
}

export function accountingRequest<T>(route: AccountingAction, body?: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(route, body, signal, '/api/erp-mini/accounting');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed. Please try again.';
}

/** Convert decimal text to integer minor units without floating-point multiplication. */
export function parsePrice(text: string, digits: number): number {
  const value = text.trim();
  const pattern = digits === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`);
  if (!pattern.test(value)) throw new Error(digits === 0 ? 'Enter a whole-number price, without separators.' : `Enter a price with at most ${digits} decimal places, without separators.`);
  const [whole = '', fraction = ''] = value.split('.');
  const minorText = `${whole}${fraction.padEnd(digits, '0')}`.replace(/^0+(?=\d)/, '');
  if (minorText.length > 13) throw new Error('Price exceeds the maximum of 1,000,000,000,000 minor units.');
  const minor = Number(minorText);
  if (!Number.isSafeInteger(minor) || minor > 1_000_000_000_000) throw new Error('Price exceeds the maximum of 1,000,000,000,000 minor units.');
  return minor;
}

export function priceText(minor: number, digits: number): string {
  const text = String(minor).padStart(digits + 1, '0');
  return digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** Keep the exact cents even for totals close to Number.MAX_SAFE_INTEGER. */
export function money(minor: number, currency: Currency): string {
  const digits = currency === 'JPY' || currency === 'VND' ? 0 : 2;
  const [whole = '', fraction] = priceText(minor, digits).split('.');
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
}
