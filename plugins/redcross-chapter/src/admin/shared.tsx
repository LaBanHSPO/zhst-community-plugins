import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { errorMessage, RequestError } from './api.js';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
	return (
		<label className="rc-field">
			<span>{label}</span>
			{children}
			{hint && <small>{hint}</small>}
		</label>
	);
}

export function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
	if (!error) return null;
	return (
		<div className="rc-error" role="alert">
			<strong>Không thể hoàn tất yêu cầu</strong>
			<p>{errorMessage(error)}</p>
			{error instanceof RequestError && error.code === 'CONFLICT' && (
				<p>
					Bản ghi đã thay đổi ở nơi khác. Dữ liệu bạn nhập vẫn được giữ nguyên; hãy tải lại bản ghi đã
					lưu trước khi chỉnh sửa tiếp.
				</p>
			)}
			{retry && (
				<button type="button" onClick={retry}>
					Thử lại
				</button>
			)}
		</div>
	);
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
		try {
			success(await operation());
		} catch (cause) {
			setError(cause);
		} finally {
			lock.current = false;
			setPending(false);
		}
	}
	return { pending, error, setError, run };
}

export function Pager({
	pageIndex,
	hasMore,
	loading,
	onPrev,
	onNext,
	shown,
}: {
	pageIndex: number;
	hasMore: boolean;
	loading: boolean;
	onPrev: () => void;
	onNext: () => void;
	shown: number;
}) {
	return (
		<nav className="rc-pagination" aria-label="Phân trang">
			<button type="button" disabled={loading || pageIndex === 0} onClick={onPrev}>
				Trang trước
			</button>
			<span>
				Trang {pageIndex + 1} · {shown} bản ghi
			</span>
			<button type="button" disabled={loading || !hasMore} onClick={onNext}>
				Trang sau
			</button>
		</nav>
	);
}

export function useDebounced(value: string, delay = 250): string {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timeout = window.setTimeout(() => setDebounced(value.trim()), delay);
		return () => window.clearTimeout(timeout);
	}, [value, delay]);
	return debounced;
}
