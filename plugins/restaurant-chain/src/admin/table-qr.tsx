import { Button } from "@cloudflare/kumo";
import { toDataURL } from "qrcode";
import { useEffect, useState } from "react";
import type { Table } from "../domain/types.js";
import { useText } from "./locale.js";
import { Failure } from "./shared.js";

export function TableQr({ table }: { table: Table }) {
	const { t } = useText();
	const [image, setImage] = useState("");
	const [error, setError] = useState<unknown>();
	const [copied, setCopied] = useState(false);
	const [revision, setRevision] = useState(0);
	const url = new URL(`/order/${encodeURIComponent(table.token)}`, window.location.origin).href;
	useEffect(() => {
		let active = true;
		setError(undefined);
		setImage("");
		toDataURL(url, {
			width: 600,
			margin: 4,
			errorCorrectionLevel: "M",
			color: { dark: "#000000", light: "#ffffff" },
		}).then(
			(value) => {
				if (active) setImage(value);
			},
			(cause: unknown) => {
				if (active) setError(cause);
			},
		);
		return () => {
			active = false;
		};
	}, [url, revision]);
	async function copy() {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			setError(undefined);
		} catch (cause) {
			setError(cause);
		}
	}
	return (
		<section className="rc-table-qr">
			<h3>{table.name}</h3>
			<p>{t("menu")}</p>
			{image && <img src={image} alt={`${t("tableQr")} ${table.name}`} width={300} height={300} />}
			<p>
				<a href={url} target="_blank" rel="noreferrer">
					{url}
				</a>
			</p>
			<Failure error={error} />
			<div className="rc-toolbar">
				{image && (
					<>
						<a href={image} download={`table-${table.id}.png`}>
							{t("downloadQr")}
						</a>
						<Button onClick={() => window.print()}>{t("print")}</Button>
					</>
				)}
				<Button
					onClick={() => {
						void copy();
					}}
				>
					{t(copied ? "copied" : "copyLink")}
				</Button>
				{Boolean(error) && (
					<Button onClick={() => setRevision((value) => value + 1)}>{t("retry")}</Button>
				)}
			</div>
		</section>
	);
}
