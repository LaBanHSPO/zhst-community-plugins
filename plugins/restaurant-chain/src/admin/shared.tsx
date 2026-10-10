import { Button, Input, Select } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CommandIdentity, request, RestaurantRequestError } from "./client.js";
import { statusKey, useText } from "./locale.js";
import type { TextKey } from "./locale.js";

export function Failure({ error }: { error: unknown }) {
	const { t } = useText();
	if (!error) return null;
	const code = error instanceof RestaurantRequestError ? error.code : "NETWORK";
	const message: TextKey = /CONFLICT|VERSION|IDEMPOTENCY/.test(code)
		? "conflict"
		: /FORBIDDEN|UNAUTHORIZED/.test(code)
			? "forbidden"
			: /CLOSED|EXPIRED|INVALID_SESSION/.test(code)
				? "closed"
				: /VALIDATION|INVALID_INPUT/.test(code)
					? "invalid"
					: "network";
	return (
		<div className="rc-error" role="alert">
			<strong>{t("error")}</strong>
			<p>{t(message)}</p>
			<small>{code}</small>
		</div>
	);
}

export function useCommand(onDone?: () => void) {
	const identity = useRef(new CommandIdentity());
	const lock = useRef(false);
	const uncertain = useRef<{ key: string; input: Record<string, unknown> } | undefined>(undefined);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<unknown>();
	const [saved, setSaved] = useState(false);
	async function run<T = unknown>(
		action: string,
		input: Record<string, unknown>,
	): Promise<T | undefined> {
		if (lock.current) return undefined;
		lock.current = true;
		setPending(true);
		setError(undefined);
		setSaved(false);
		const key = JSON.stringify([action, { ...input, expectedVersion: undefined }]);
		if (uncertain.current?.key !== key) uncertain.current = { key, input };
		const submitted = uncertain.current.input;
		try {
			const data = await request<T>(
				action,
				{ ...submitted, commandId: identity.current.for(action, submitted) },
				{ mutation: true },
			);
			identity.current.complete();
			uncertain.current = undefined;
			setSaved(true);
			onDone?.();
			return data;
		} catch (cause) {
			if (
				cause instanceof RestaurantRequestError &&
				/CONFLICT|VERSION|VALIDATION|FORBIDDEN|UNAUTHORIZED|CLOSED|EXPIRED|NOT_FOUND|INVALID_INPUT/.test(
					cause.code,
				)
			) {
				uncertain.current = undefined;
				identity.current.complete();
			}
			setError(cause);
			return undefined;
		} finally {
			lock.current = false;
			setPending(false);
		}
	}
	return { run, pending, error, saved };
}

export function Action({
	action,
	input,
	label,
	onDone,
	disabled = false,
	reason = false,
}: {
	action: string;
	input: Record<string, unknown>;
	label: TextKey;
	onDone: () => void;
	disabled?: boolean;
	reason?: boolean;
}) {
	const { t } = useText();
	const mutation = useCommand(onDone);
	const [text, setText] = useState("");
	return (
		<div className="rc-action">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void mutation.run(action, reason ? { ...input, reason: text } : input);
				}}
			>
				{reason && (
					<Input
						label={t("reason")}
						value={text}
						onChange={(event) => setText(event.target.value)}
						required
						maxLength={1000}
					/>
				)}
				<Button type="submit" disabled={disabled || mutation.pending || (reason && !text.trim())}>
					{mutation.pending ? t("saving") : t(label)}
				</Button>
			</form>
			<Failure error={mutation.error} />
		</div>
	);
}

export function Choice({
	label,
	value,
	options,
	onChange,
	disabled = false,
}: {
	label: string;
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
	disabled?: boolean;
}) {
	return (
		<Select
			label={label}
			value={value}
			items={options}
			disabled={disabled}
			onValueChange={(next) => {
				if (typeof next === "string") onChange(next);
			}}
		/>
	);
}

export function Status({ value, label }: { value: string; label?: TextKey }) {
	const { t } = useText();
	return (
		<span className="rc-status" data-status={value}>
			{t(label ?? statusKey(value))}
		</span>
	);
}

export function Section({
	title,
	children,
	hint,
}: {
	title: string;
	children: ReactNode;
	hint?: string;
}) {
	return (
		<section className="rc-section">
			<h2>{title}</h2>
			{hint && <p className="rc-muted">{hint}</p>}
			{children}
		</section>
	);
}

export function useUnsaved(dirty: boolean) {
	useEffect(() => {
		if (!dirty) return;
		const handler = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);
}
