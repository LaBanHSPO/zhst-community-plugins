import { apiFetch, parseApiResponse } from 'emdash/plugin-utils';
import type { ApiResult } from '../model.js';

export class RequestError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'RequestError';
	}
}

const BASE = '/_emdash/api/plugins/redcross-chapter';

export async function request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	const response = await apiFetch(`${BASE}/${route}`, {
		method: body === undefined ? 'GET' : 'POST',
		credentials: 'same-origin',
		headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});
	const result = await parseApiResponse<ApiResult<T>>(response, 'Hội Chữ thập đỏ request failed');
	if (
		!result ||
		typeof result.ok !== 'boolean' ||
		(result.ok ? !('data' in result) : !result.error || typeof result.error.code !== 'string')
	) {
		throw new Error('The server returned an unexpected response. Reload and try again.');
	}
	if (!result.ok) throw new RequestError(result.error.code, result.error.message);
	return result.data;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'The request could not be completed. Please try again.';
}

/** VND has no minor units: format integer đồng with grouping separators. */
export function money(amountMinor: number): string {
	const sign = amountMinor < 0 ? '−' : '';
	const digits = Math.abs(amountMinor).toString();
	return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} đ`;
}

export function parseAmount(text: string): number {
	const value = text.replace(/[.\s,]/g, '').trim();
	if (!/^\d+$/.test(value)) throw new Error('Enter a whole-number amount in đồng (no decimals).');
	const amount = Number(value);
	if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000_000_000) {
		throw new Error('The amount is outside the supported range.');
	}
	return amount;
}

export function formatDate(value: string): string {
	const [year, month, day] = value.split('-');
	return year && month && day ? `${day}/${month}/${year}` : value;
}

export function downloadCsv(filename: string, csv: string): void {
	const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}
