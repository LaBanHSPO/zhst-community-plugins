import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const stroke = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.7,
	strokeLinecap: "round" as const,
	strokeLinejoin: "round" as const,
};

/** The restaurant chain chef-hat mark used by the workspace and guest surfaces. */
export function ChefHat(props: IconProps) {
	return (
		<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" {...props}>
			<circle cx="10.5" cy="12.5" r="5" fill="currentColor" />
			<circle cx="16" cy="10" r="6" fill="currentColor" />
			<circle cx="21.5" cy="12.5" r="5" fill="currentColor" />
			<rect x="9" y="15.5" width="14" height="6.5" rx="2.6" fill="currentColor" />
		</svg>
	);
}

export function RestaurantLogo({
	label,
	subtitle,
	compact = false,
}: {
	label: string;
	subtitle?: string;
	compact?: boolean;
}) {
	return (
		<span className="rc-brand" data-compact={compact ? "" : undefined}>
			<span className="rc-brand-mark" aria-hidden="true">
				<ChefHat />
			</span>
			<span className="rc-brand-text">
				<strong>{label}</strong>
				{subtitle && <small>{subtitle}</small>}
			</span>
		</span>
	);
}

export function IconFloor(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<rect x="3" y="3" width="7" height="7" rx="1.6" {...stroke} />
			<rect x="14" y="3" width="7" height="7" rx="1.6" {...stroke} />
			<rect x="3" y="14" width="7" height="7" rx="1.6" {...stroke} />
			<rect x="14" y="14" width="7" height="7" rx="1.6" {...stroke} />
		</svg>
	);
}

export function IconOrders(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" {...stroke} />
			<path d="M14.5 3v4.5H19" {...stroke} />
			<path d="M8.5 12.5h7M8.5 16h5" {...stroke} />
		</svg>
	);
}

export function IconMenu(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<path d="M7 3v8a2.5 2.5 0 0 0 5 0V3" {...stroke} />
			<path d="M9.5 11v10" {...stroke} />
			<path d="M17 3c-1.4 0-2.5 2-2.5 4.5S15.6 12 17 12v9" {...stroke} />
		</svg>
	);
}

export function IconStaff(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<circle cx="12" cy="8" r="3.4" {...stroke} />
			<path d="M4.5 20a7.5 7.5 0 0 1 15 0" {...stroke} />
		</svg>
	);
}

export function IconCard(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<rect x="2.5" y="5" width="19" height="14" rx="2.4" {...stroke} />
			<path d="M2.5 9.5h19" {...stroke} />
			<path d="M6 14.5h4" {...stroke} />
		</svg>
	);
}

export function IconExport(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<path d="M12 3v11" {...stroke} />
			<path d="m8 10 4 4 4-4" {...stroke} />
			<path d="M4.5 17v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V17" {...stroke} />
		</svg>
	);
}

export function IconSettings(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<circle cx="12" cy="12" r="3.2" {...stroke} />
			<path
				d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.7-1.3-2-3.4-2 .8a7.6 7.6 0 0 0-2.6-1.5L14 3h-4l-.5 2.1a7.6 7.6 0 0 0-2.6 1.5l-2-.8-2 3.4 1.7 1.3a7.6 7.6 0 0 0 0 3L3 14.8l2 3.4 2-.8a7.6 7.6 0 0 0 2.6 1.5L10 21h4l.5-2.1a7.6 7.6 0 0 0 2.6-1.5l2 .8 2-3.4Z"
				{...stroke}
			/>
		</svg>
	);
}

export function IconRefresh(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<path d="M20 11a8 8 0 0 0-14.5-4" {...stroke} />
			<path d="M4 13a8 8 0 0 0 14.5 4" {...stroke} />
			<path d="M5 4v3.5h3.5M19 20v-3.5h-3.5" {...stroke} />
		</svg>
	);
}

export function IconQr(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<rect x="3" y="3" width="7" height="7" rx="1.4" {...stroke} />
			<rect x="14" y="3" width="7" height="7" rx="1.4" {...stroke} />
			<rect x="3" y="14" width="7" height="7" rx="1.4" {...stroke} />
			<path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h.01" {...stroke} />
		</svg>
	);
}

export function IconChevron(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<path d="m8 10 4 4 4-4" {...stroke} />
		</svg>
	);
}

export function IconSearch(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<circle cx="11" cy="11" r="6.5" {...stroke} />
			<path d="m16 16 4 4" {...stroke} />
		</svg>
	);
}

export function IconBell(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5 1.5 5H5s1.5-1 1.5-5Z" {...stroke} />
			<path d="M10.5 19a1.8 1.8 0 0 0 3 0" {...stroke} />
		</svg>
	);
}

export function IconPlus(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<path d="M12 5v14M5 12h14" {...stroke} />
		</svg>
	);
}

export function IconShift(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
			<circle cx="12" cy="12" r="9" {...stroke} />
			<path d="M12 7.5V12l3 2" {...stroke} />
		</svg>
	);
}
