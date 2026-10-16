// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// MoltenTerm's confirmation dialogs (the worktree close, the Sessions view): a frame over the window, a title and its
// subtitle, the content, then the buttons; Escape answers like the dialog's cancel.

import { cn } from "@/util/util";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ScrimClass } from "./modal-open";
import { captureModalInvoker, containModalFocus, modalOwnsKeys, topModal } from "./modal-focus";
import { GlowRing } from "./suite/suite";

// The overlay rule and its scrim live in modal-open.ts, which the global keys read without loading React.
export { modalIsOpen, ScrimClass } from "./modal-open";

// enabled may be a function, read at the key press, for a state the component does not render from.
export function useEscape(enabled: boolean | (() => boolean), onEscape: () => void, role?: string | string[]) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && modalOwnsKeys(role)) {
                const allowed = typeof enabled === "function" ? enabled() : enabled;
                if (!allowed && role == null) {
                    return;
                }
                e.stopPropagation();
                e.preventDefault();
                if (role != null) {
                    e.stopImmediatePropagation();
                }
                if (allowed) {
                    onEscape();
                }
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    });
}

export function DialogFrame({
    role,
    title,
    subtitle,
    subtitleClass,
    subtitleTooltip,
    belowSubtitle,
    subtitleWraps,
    wide,
    widthClass,
    onBackdrop,
    onEscape,
    suite,
    children,
    buttons,
}: {
    role: string;
    title: string;
    subtitle?: string;
    // Replaces the subtitle's text style (a path is mono 11).
    subtitleClass?: string;
    // The subtitle's hover text when it says more than the subtitle (a folder's full path under its name).
    subtitleTooltip?: string;
    // A quiet line under the subtitle (the suite signature in the version history).
    belowSubtitle?: React.ReactNode;
    // A sentence rather than a path or a name: it wraps instead of being cut.
    subtitleWraps?: boolean;
    wide?: boolean;
    // Replaces the width that `wide` picks.
    widthClass?: string;
    // Compatibility for existing callers; modal containment is always enabled.
    trapFocus?: boolean;
    // A press outside the dialog, for a dialog whose close loses nothing.
    onBackdrop?: () => void;
    // Undefined keeps Escape blocked while a confirmation is busy.
    onEscape?: () => void;
    // The DiamondForge suite frame (#658): low corners, the turning light around it, and room for its section blocks'
    // chips and corner icons.
    suite?: boolean;
    children: React.ReactNode;
    buttons: React.ReactNode;
}) {
    const backdropPressed = useRef(false);
    const dialogRef = useRef<HTMLDivElement>(null);
    const [invoker] = useState(captureModalInvoker);
    const escape = useRef(onEscape);
    escape.current = onEscape;
    // A layout effect: a dialog opened from a pane (branch cleaning, #746) sees the pane take its focus back in the
    // same click, before a passive effect would be listening.
    useLayoutEffect(() => {
        const dialog = dialogRef.current;
        const release = containModalFocus(dialog, invoker);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && topModal() === dialog) {
                e.preventDefault();
                e.stopImmediatePropagation();
                escape.current?.();
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("keydown", onKey, true);
            release();
        };
    }, [invoker]);
    return createPortal(
        <div
            className={cn("fixed inset-0 z-[9600] flex items-center justify-center", ScrimClass)}
            data-role={role}
            onMouseDown={(e) => {
                backdropPressed.current = e.target === e.currentTarget;
            }}
            onMouseUp={(e) => {
                // Both ends on the backdrop: a text selection that starts in the dialog and ends outside closes nothing.
                const outside = backdropPressed.current && e.target === e.currentTarget;
                backdropPressed.current = false;
                if (outside && onBackdrop != null && topModal() === dialogRef.current) {
                    onBackdrop();
                }
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                tabIndex={-1}
                className={cn(
                    "flex max-h-[calc(100vh-64px)] max-w-[calc(100vw-32px)] flex-col border border-border bg-surface-3 shadow-e3",
                    suite ? "relative rounded-4" : "rounded-10",
                    widthClass ?? (wide ? "w-[600px]" : "w-[500px]")
                )}
            >
                <div className="border-b border-border px-4 py-3">
                    <div className="text-13 leading-5 font-semibold">{title}</div>
                    {subtitle ? (
                        <div
                            className={cn(
                                "mt-0.5 text-muted",
                                !subtitleWraps && "truncate",
                                subtitleClass ?? "text-12"
                            )}
                            title={subtitleTooltip ?? (subtitleWraps ? undefined : subtitle)}
                        >
                            {subtitle}
                        </div>
                    ) : null}
                    {belowSubtitle}
                </div>
                {suite ? <GlowRing on /> : null}
                <div
                    className={cn(
                        "flex min-h-0 flex-col overflow-auto text-12",
                        suite ? "px-6 pt-1 pb-6" : "gap-3 px-4 py-3"
                    )}
                >
                    {children}
                </div>
                <div data-dialog-buttons className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                    {buttons}
                </div>
            </div>
        </div>,
        document.body
    );
}
