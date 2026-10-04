// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// MoltenTerm's confirmation dialogs (the worktree close, the Sessions view): a frame over the window, a title and its
// subtitle, the content, then the buttons; Escape answers like the dialog's cancel.

import { cn } from "@/util/util";
import { useEffect } from "react";
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

export function DialogFrame({
    role,
    title,
    subtitle,
    wide,
    children,
    buttons,
}: {
    role: string;
    title: string;
    subtitle?: string;
    wide?: boolean;
    children: React.ReactNode;
    buttons: React.ReactNode;
}) {
    return createPortal(
        <div className="fixed inset-0 z-[9600] flex items-center justify-center bg-black/40" data-role={role}>
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className={cn(
                    "flex max-h-[calc(100vh-64px)] max-w-[calc(100vw-32px)] flex-col rounded border border-border bg-modalbg shadow-xl",
                    wide ? "w-[600px]" : "w-[500px]"
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
