// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// MoltenTerm's confirmation dialogs (the worktree close, the Sessions view): a frame over the window, a title and its
// subtitle, the content, then the buttons; Escape answers like the dialog's cancel.

import { cn } from "@/util/util";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function useEscape(enabled: boolean, onEscape: () => void) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && enabled) {
                e.stopPropagation();
                e.preventDefault();
                onEscape();
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    });
}

const FocusableSelector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Tab and Shift+Tab stay inside the dialog (NFR-SHELL-014): aria-modal alone does not keep the keyboard in it.
function keepFocusInside(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") {
        return;
    }
    const focusables = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FocusableSelector)).filter(
        (el) => el.getClientRects().length > 0
    );
    if (focusables.length === 0) {
        e.preventDefault();
        return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const inside = e.currentTarget.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
    }
}

export function DialogFrame({
    role,
    title,
    subtitle,
    wide,
    widthClass,
    trapFocus,
    onBackdrop,
    children,
    buttons,
}: {
    role: string;
    title: string;
    subtitle?: string;
    wide?: boolean;
    // Replaces the width that `wide` picks.
    widthClass?: string;
    trapFocus?: boolean;
    // A press outside the dialog, for a dialog whose close loses nothing.
    onBackdrop?: () => void;
    children: React.ReactNode;
    buttons: React.ReactNode;
}) {
    const backdropPressed = useRef(false);
    return createPortal(
        <div
            className="fixed inset-0 z-[9600] flex items-center justify-center bg-black/40"
            data-role={role}
            onMouseDown={(e) => {
                backdropPressed.current = e.target === e.currentTarget;
            }}
            onMouseUp={(e) => {
                // Both ends on the backdrop: a text selection that starts in the dialog and ends outside closes nothing.
                const outside = backdropPressed.current && e.target === e.currentTarget;
                backdropPressed.current = false;
                if (outside && onBackdrop != null) {
                    onBackdrop();
                }
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onKeyDown={trapFocus ? keepFocusInside : undefined}
                className={cn(
                    "flex max-h-[calc(100vh-64px)] max-w-[calc(100vw-32px)] flex-col rounded border border-border bg-modalbg shadow-xl",
                    widthClass ?? (wide ? "w-[600px]" : "w-[500px]")
                )}
            >
                <div className="border-b border-border px-4 py-3">
                    <div className="text-sm font-semibold">{title}</div>
                    {subtitle ? (
                        <div className="mt-0.5 truncate text-xs text-muted" title={subtitle}>
                            {subtitle}
                        </div>
                    ) : null}
                </div>
                <div className="flex min-h-0 flex-col gap-3 overflow-auto px-4 py-3 text-xs">{children}</div>
                <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">{buttons}</div>
            </div>
        </div>,
        document.body
    );
}
