// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The empty and error state of MoltenTerm's own surfaces (FR-SHELL-053, DS-SHELL-094): what happened in plain words
// and the next action. Raw output (git's stderr, an RPC error, an error code) only goes under Details, collapsed, so
// no identifier, stack or stderr reaches the title or the hint (DS-SHELL-079).

import { cn } from "@/util/util";
import { MoltenWave } from "./molten-button";

export type EmptyStateAction = {
    label: string;
    // A menu opener (Attach to a terminal ▾) gets the event to anchor its menu.
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    // Draws the caret of an action that opens a menu.
    menu?: boolean;
    disabled?: boolean;
    // Shown instead of the label while the action runs.
    busyLabel?: string;
    busy?: boolean;
    title?: string;
    testId?: string;
};

export type EmptyStateProps = {
    // A Font Awesome icon name, drawn at 20 px.
    icon: string;
    title: string;
    // One sentence.
    hint?: string;
    primary?: EmptyStateAction;
    secondary?: EmptyStateAction;
    // A failed action, in plain words (its raw error goes to details).
    alert?: string;
    // Raw output for the curious, behind a collapsed disclosure.
    details?: string;
    // Content under the actions (Mission Control's reduced project view).
    children?: React.ReactNode;
    // The column fills its parent and centres itself; compact drops the vertical centring for a section.
    compact?: boolean;
    className?: string;
    testId?: string;
};

const PrimaryClass =
    "molten-btn inline-flex h-row cursor-pointer items-center gap-1.5 rounded-6 px-3 text-12 font-medium disabled:opacity-60";
const SecondaryClass =
    "molten-btn-secondary inline-flex h-row cursor-pointer items-center gap-1.5 rounded-6 px-3 text-12 disabled:opacity-60";

// A secondary action with no primary beside it would read as plain text: alone, it gets the calm button's border.
function ActionButton({ action, primary, alone }: { action: EmptyStateAction; primary: boolean; alone?: boolean }) {
    return (
        <button
            type="button"
            className={primary ? PrimaryClass : cn(SecondaryClass, alone && "border border-line")}
            onClick={action.onClick}
            disabled={action.disabled || action.busy}
            aria-busy={action.busy || undefined}
            aria-haspopup={action.menu ? "menu" : undefined}
            title={action.title}
            data-testid={action.testId}
        >
            {action.busy && action.busyLabel ? action.busyLabel : action.label}
            {action.menu ? <i className="fa fa-solid fa-chevron-down text-11" aria-hidden /> : null}
            {primary ? <MoltenWave /> : null}
        </button>
    );
}

export function EmptyState({
    icon,
    title,
    hint,
    primary,
    secondary,
    alert,
    details,
    children,
    compact,
    className,
    testId,
}: EmptyStateProps) {
    const hasActions = primary != null || secondary != null;
    return (
        <div
            className={cn(
                "flex w-full justify-center p-6",
                compact ? "" : "h-full min-h-0 items-center overflow-y-auto",
                className
            )}
            data-testid={testId}
            data-role="molten-empty-state"
        >
            <div className="flex w-full max-w-[360px] flex-col items-center gap-2 text-center">
                <i className={cn("fa fa-solid text-icon-20 text-muted", `fa-${icon}`)} aria-hidden />
                <div className="text-13 leading-5 font-semibold text-primary" role="heading" aria-level={2}>
                    {title}
                </div>
                {hint ? <p className="text-12 leading-[18px] text-muted">{hint}</p> : null}
                {hasActions ? (
                    <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                        {primary != null ? <ActionButton action={primary} primary /> : null}
                        {secondary != null ? (
                            <ActionButton action={secondary} primary={false} alone={primary == null} />
                        ) : null}
                    </div>
                ) : null}
                {alert ? (
                    <p className="text-12 leading-[18px] text-danger" role="alert">
                        {alert}
                    </p>
                ) : null}
                {details ? <EmptyStateDetails text={details} /> : null}
                {children}
            </div>
        </div>
    );
}

// The disclosure keeps its native keyboard behaviour (Enter and Space on the summary).
export function EmptyStateDetails({ text }: { text: string }) {
    return (
        <details className="group mt-2 w-full text-left" data-testid="empty-state-details">
            <summary className="mx-auto flex w-fit cursor-pointer list-none items-center gap-1 rounded-4 px-1.5 py-0.5 text-11 text-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                <i
                    className="fa fa-solid fa-chevron-right text-11 transition-transform duration-120 ease-mt group-open:rotate-90"
                    aria-hidden
                />
                Details
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto rounded-4 border border-line bg-surface-2 p-2 font-mono text-11 leading-4 break-words whitespace-pre-wrap text-secondary select-text">
                {text}
            </pre>
        </details>
    );
}
