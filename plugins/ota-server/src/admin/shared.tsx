/**
 * Shared admin building blocks: async state, error surface, copy buttons and
 * the small view helpers used by every tab.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { OtaRequestError, errorMessage } from "./client.js";
import { formatBytes } from "../domain/data.js";

export interface AsyncState<T> {
	data?: T;
	error?: unknown;
	loading: boolean;
	reload: () => void;
}

/** Load data for a tab and expose a manual reload trigger. */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
	const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
	const [nonce, setNonce] = useState(0);
	const loaderRef = useRef(loader);
	loaderRef.current = loader;
	useEffect(() => {
		const controller = new AbortController();
		setState((current) => ({ ...current, loading: true, error: undefined }));
		loaderRef
			.current(controller.signal)
			.then((data) => {
				if (!controller.signal.aborted) setState({ data, loading: false });
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) setState({ error, loading: false });
			});
		return () => controller.abort();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- caller controls the dependency list
	}, [...deps, nonce]);
	return { ...state, reload: () => setNonce((value) => value + 1) };
}

export function Failure({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
	if (!error) return null;
	const code = error instanceof OtaRequestError ? error.code : "UNKNOWN";
	return (
		<div className="ota-error" role="alert">
			<strong>Request failed</strong>
			<p>{errorMessage(error)}</p>
			<small>
				{code}
				{onRetry ? (
					<>
						{" · "}
						<button type="button" className="ota-link" onClick={onRetry}>
							Retry
						</button>
					</>
				) : null}
			</small>
		</div>
	);
}

export function Section({
	title,
	description,
	actions,
	children,
}: {
	title: string;
	description?: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="ota-section">
			<div className="ota-section-head">
				<div>
					<h2>{title}</h2>
					{description ? <p className="ota-muted">{description}</p> : null}
				</div>
				{actions ? <div className="ota-section-actions">{actions}</div> : null}
			</div>
			{children}
		</section>
	);
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div className="ota-stat">
			<span className="ota-stat-label">{label}</span>
			<strong>{value}</strong>
			{hint ? <small className="ota-muted">{hint}</small> : null}
		</div>
	);
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			timer.current = window.setTimeout(() => setCopied(false), 2000);
		} catch {
			setCopied(false);
		}
	}
	return (
		<button type="button" className="ota-copy" onClick={() => void copy()} aria-live="polite">
			{copied ? "Copied" : label}
		</button>
	);
}

export function bytes(value: number): string {
	return formatBytes(value);
}

export function when(value: string | null): string {
	if (!value) return "—";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function shortHash(value: string, length = 12): string {
	return value.length <= length ? value : `${value.slice(0, length)}…`;
}
