// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// DiamondForge suite kit (#658): plain React over suite.css, with no app import and no Tailwind class, so the folder
// moves as is into the shared UI kit. Text comes from the caller (each app owns its translations); icons are
// components, the suite's Lucide set (suite-icons.ts).

import { useId, useRef } from "react";
import "./suite.css";

export type SuiteIcon = React.ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;

export function joinClasses(...parts: (string | false | null | undefined)[]): string {
    return parts.filter(Boolean).join(" ");
}

// The turning light of a highlighted frame. The frame must be positioned and rounded; `on` lights it (or .df-glow-on
// on the frame).
export function GlowRing({ on }: { on?: boolean }) {
    return <span className="df-glow" data-on={on ? "" : undefined} aria-hidden />;
}

export type SectionBlockProps = Omit<React.HTMLAttributes<HTMLElement>, "title"> & {
    // The label chip on the top border; a block without one has no pocket.
    title?: string;
    icon?: SuiteIcon;
    description?: React.ReactNode;
    // An action straddling the bottom border, right side.
    footer?: React.ReactNode;
    // Lights the turning light around the block.
    glow?: boolean;
    tone?: "danger";
    // The chip upper-cases its label; "as-is" keeps a name whose case matters (a secret, a path).
    titleCase?: "upper" | "as-is";
    children?: React.ReactNode;
};

export function SectionBlock({
    title,
    icon: Icon,
    description,
    footer,
    glow,
    tone,
    titleCase,
    children,
    className,
    ...rest
}: SectionBlockProps) {
    const headingId = useId();
    return (
        <section
            aria-labelledby={title ? headingId : undefined}
            {...rest}
            className={joinClasses("df-block", className)}
            data-untitled={title ? undefined : ""}
            data-footer={footer ? "" : undefined}
            data-tone={tone}
            data-chip-case={titleCase === "as-is" ? "as-is" : undefined}
        >
            <GlowRing on={glow} />
            {Icon ? (
                <span className="df-icon-tile" aria-hidden>
                    <Icon strokeWidth={2} aria-hidden />
                </span>
            ) : null}
            {title ? (
                <span className="df-pocket">
                    <span className="df-chip">
                        <h3 id={headingId} className="df-chip-text">
                            {title}
                        </h3>
                    </span>
                </span>
            ) : null}
            <div className="df-block-body">
                {description ? <p className="df-block-desc">{description}</p> : null}
                {children}
            </div>
            {footer ? <span className="df-pocket df-pocket-bottom">{footer}</span> : null}
        </section>
    );
}

// Rows flush with the block's edges, divided by hairlines; they close the block.
export function BlockRows({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div {...rest} className={joinClasses("df-block-rows", className)}>
            {children}
        </div>
    );
}

// Option rows stacked under a row or inside a block, divided by hairlines: one radio group.
export function OptionList({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div role="radiogroup" {...rest} className={joinClasses("df-option-list", className)}>
            {children}
        </div>
    );
}

export function RadioDot() {
    return <span className="df-radio" aria-hidden />;
}

export type OptionRowProps = {
    name: string;
    selected: boolean;
    onSelect: () => void;
    label: string;
    icon?: SuiteIcon;
    // Muted text after the label.
    meta?: string;
    disabled?: boolean;
    // The "Selected" mark, in the app's language.
    selectedLabel: string;
    className?: string;
    value?: string;
};

export function OptionRow({
    name,
    selected,
    onSelect,
    label,
    icon: Icon,
    meta,
    disabled,
    selectedLabel,
    className,
    value,
}: OptionRowProps) {
    return (
        <label
            className={joinClasses("df-option-row", className)}
            data-selected={selected ? "" : undefined}
            data-disabled={disabled ? "" : undefined}
            data-option={value}
        >
            <input
                type="radio"
                className="df-sr-only"
                name={name}
                value={value}
                checked={selected}
                disabled={disabled}
                onChange={onSelect}
            />
            <RadioDot />
            {Icon ? <Icon className="df-option-icon" aria-hidden /> : null}
            <span className="df-option-label">
                {label}
                {meta ? <span className="df-option-meta">{meta}</span> : null}
            </span>
            {selected ? <span className="df-option-selected">{selectedLabel}</span> : null}
        </label>
    );
}

export type ToggleOption<T extends string> = { value: T; label: string; icon?: SuiteIcon; title?: string };

// Arrow keys move and choose, Home and End jump (WAI-ARIA radio group); -1 when the key is not one of them.
export function nextToggleIndex(key: string, from: number, count: number): number {
    if (count === 0) {
        return -1;
    }
    switch (key) {
        case "ArrowRight":
        case "ArrowDown":
            return from < 0 ? 0 : (from + 1) % count;
        case "ArrowLeft":
        case "ArrowUp":
            return from < 0 ? count - 1 : (from - 1 + count) % count;
        case "Home":
            return 0;
        case "End":
            return count - 1;
        default:
            return -1;
    }
}

// The suite's signature (#740): "MoltenTerm 1.0.0 · A DiamondForge product", muted and small, in the app's quiet
// places (the end of Settings' sidebar, under the version in the version history), never on a work surface. Each app
// passes its name, its version and its translation of the label.
export function SuiteSignature({
    product,
    version,
    label,
    className,
}: {
    product?: string;
    version?: string;
    label: string;
    className?: string;
}) {
    const name = [product, version].filter(Boolean).join(" ");
    return (
        <p className={joinClasses("df-signature", className)} data-suite-signature="">
            {name ? (
                <>
                    <span className="df-signature-product">{name} ·</span>{" "}
                </>
            ) : null}
            <span className="df-signature-label">{label}</span>
        </p>
    );
}

// Exclusive choices as separate bordered rectangles, the chosen one outlined in the accent; one tab stop.
export function ToggleGroup<T extends string>({
    label,
    options,
    selected,
    onSelect,
    className,
}: {
    label: string;
    options: ToggleOption<T>[];
    selected: T;
    onSelect: (value: T) => void;
    className?: string;
}) {
    const groupRef = useRef<HTMLDivElement>(null);
    const selectedIndex = options.findIndex((o) => o.value === selected);
    const tabStop = selectedIndex < 0 ? 0 : selectedIndex;
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const radios = Array.from(groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
        const next = nextToggleIndex(e.key, radios.indexOf(document.activeElement as HTMLElement), options.length);
        if (next < 0) {
            return;
        }
        e.preventDefault();
        radios[next]?.focus();
        onSelect(options[next].value);
    };
    return (
        <div
            ref={groupRef}
            role="radiogroup"
            aria-label={label}
            className={joinClasses("df-toggle-group", className)}
            onKeyDown={onKeyDown}
        >
            {options.map((o, i) => {
                const Icon = o.icon;
                return (
                    <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={o.value === selected}
                        title={o.title}
                        tabIndex={i === tabStop ? 0 : -1}
                        className="df-toggle"
                        onClick={() => onSelect(o.value)}
                    >
                        {Icon ? <Icon aria-hidden /> : null}
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}
