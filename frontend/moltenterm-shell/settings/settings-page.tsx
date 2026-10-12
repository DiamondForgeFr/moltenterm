// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The page language Settings, Secrets and Tips share (#534): a centred column, a header with a title and one line,
// and cards holding a group of rows. One place, so the three read as the same app.

import { cn } from "@/util/util";

// The centred column; a wide pane leaves room on both sides instead of pushing everything to the left.
export function PageColumn({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("mx-auto flex w-full max-w-[760px] flex-col px-8 pt-6 pb-12 @max-w600:px-3", className)}>
            {children}
        </div>
    );
}

export function PageHeader({
    title,
    description,
    icon,
    children,
}: {
    title: string;
    description?: React.ReactNode;
    icon?: string;
    children?: React.ReactNode;
}) {
    return (
        <header className="flex items-start gap-3 pb-2">
            {icon ? (
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-6 bg-surface-2 text-accent">
                    <i className={`fa fa-solid fa-${icon} text-icon-16`} aria-hidden />
                </span>
            ) : null}
            <div className="min-w-0 flex-1">
                <h2 className="text-20 leading-8 font-semibold text-primary">{title}</h2>
                {description ? <p className="text-13 leading-5 text-secondary">{description}</p> : null}
            </div>
            {children ? <div className="flex shrink-0 items-center gap-2 pt-1">{children}</div> : null}
        </header>
    );
}

// A group of rows: its heading above, the rows in one card divided by lines.
export function PageCard({
    title,
    hint,
    children,
    className,
    label,
}: {
    title?: string;
    hint?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
    label?: string;
}) {
    return (
        <section aria-label={label ?? title} className={cn("flex flex-col pt-6", className)}>
            {title ? (
                <div className="flex items-baseline gap-2 px-1 pb-2">
                    <h3 className="text-12 font-semibold text-primary">{title}</h3>
                    {hint ? <span className="truncate text-12 text-muted">{hint}</span> : null}
                </div>
            ) : null}
            <div className="flex flex-col rounded-6 border border-line bg-surface-2/40 shadow-e1">{children}</div>
        </section>
    );
}

// A row of a card: label and description on the left, the control on the right.
export const PageRowClass = "flex items-center gap-4 border-b border-line px-4 py-3 last:border-b-0";
