// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A CI/CD row's actions (FR-SHELL-057, DS-SHELL-099): Logs, Rerun and GitHub as 24 px ghost buttons that appear inside
// the row on hover and when the keyboard focuses into it. Their slot keeps its width while hidden, so nothing moves and
// nothing written in the row is covered (NFR-SHELL-029); the fade uses the fast token, 0 under reduced motion. A rerun
// asks first, inside the row (the CI view's confirmation).

import { cn } from "@/util/util";
import { useEffect, useRef } from "react";

export const RowActionsClass =
    "pointer-events-none flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-120 ease-mt group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100";

// The row itself: the group the actions answer to, filled on hover and while focus is inside.
export const ActionRowClass =
    "group relative border-b border-border last:border-b-0 transition-colors duration-120 ease-mt hover:bg-hover focus-within:bg-hover";

export function RowActions({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className={RowActionsClass} role="group" aria-label={label} data-testid="ci-row-actions">
            {children}
        </div>
    );
}

export function RowAction({
    icon,
    label,
    onClick,
    pressed,
    expanded,
    testId,
    buttonRef,
    disabled,
}: {
    icon: string;
    label: string;
    onClick: () => void;
    pressed?: boolean;
    expanded?: boolean;
    testId?: string;
    buttonRef?: React.Ref<HTMLButtonElement>;
    disabled?: boolean;
}) {
    return (
        <button
            ref={buttonRef}
            type="button"
            disabled={disabled}
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            aria-label={label}
            aria-pressed={pressed}
            aria-expanded={expanded}
            title={label}
            className={cn(
                "molten-btn-ghost flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-icon-14 hover:bg-surface-2 hover:text-primary disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent",
                pressed || expanded ? "text-primary" : "text-muted"
            )}
            data-testid={testId}
        >
            <i className={cn("fa", icon)} aria-hidden />
        </button>
    );
}

// The question a rerun asks, in the row: Escape or Cancel leaves it, and the focus goes back to the Rerun button.
export function RerunConfirm({
    question,
    confirmLabel,
    busy,
    error,
    onConfirm,
    onCancel,
}: {
    question: string;
    confirmLabel: string;
    busy: boolean;
    error: string;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        cancelRef.current?.focus();
    }, []);
    return (
        <div
            role="alertdialog"
            aria-label={question}
            className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-6 border border-warning/40 bg-warning/10 px-2 py-1.5"
            onKeyDown={(e) => {
                if (e.key === "Escape" && !busy) {
                    e.stopPropagation();
                    onCancel();
                }
            }}
            data-testid="ci-rerun-confirm"
        >
            <span className="min-w-0 flex-1 text-12 text-primary">{question}</span>
            <button
                ref={cancelRef}
                type="button"
                className="molten-btn-secondary h-6 cursor-pointer rounded-6 px-2 text-12"
                onClick={onCancel}
                disabled={busy}
            >
                Cancel
            </button>
            <button
                type="button"
                className="molten-btn-secondary h-6 cursor-pointer rounded-6 px-2 text-12 font-medium text-primary"
                onClick={onConfirm}
                disabled={busy}
                aria-busy={busy}
                data-testid="ci-rerun-confirm-go"
            >
                {busy ? "Starting…" : confirmLabel}
            </button>
            {error ? (
                <span className="basis-full text-12 text-danger" role="alert">
                    {error}
                </span>
            ) : null}
        </div>
    );
}
