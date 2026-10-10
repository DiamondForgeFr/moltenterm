// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The toast stack (FR-SHELL-055, DS-SHELL-097): bottom right, above the status bar, 360 px wide, the newest at the
// bottom. A toast enters in 240 ms (instant under reduced motion), leaves by itself after 6 s unless it waits for a
// gesture, and holds while pointed at or focused. Escape dismisses the focused toast.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { InlineCodeText, plainInlineText } from "./inline-code";
import { Toast, ToastDismissMs, toneOf } from "./toast-model";
import { Toasts } from "./toast-store";
import "./toast.css";

const FirstActionClass =
    "molten-btn-secondary h-6 cursor-pointer rounded-6 bg-line px-2 text-12 font-medium text-primary disabled:opacity-60";
const OtherActionClass =
    "molten-btn-ghost h-6 cursor-pointer rounded-6 px-2 text-12 text-secondary hover:text-primary disabled:opacity-60";

function ToastItem({ toast }: { toast: Toast }) {
    const model = Toasts.getInstance();
    const tone = toneOf(toast.kind);
    const [running, setRunning] = useState<string>(null);
    const [held, setHeld] = useState(false);
    const [thumbFailed, setThumbFailed] = useState(false);
    const remaining = useRef(ToastDismissMs);
    const started = useRef(0);

    // The countdown restarts where it stopped: a toast pointed at for a while still gets the rest of its time.
    useEffect(() => {
        if (toast.stays || held || running != null) {
            return;
        }
        started.current = Date.now();
        const timer = setTimeout(() => model.dismiss(toast.id, "timeout"), remaining.current);
        return () => {
            clearTimeout(timer);
            remaining.current = Math.max(1000, remaining.current - (Date.now() - started.current));
        };
    }, [toast.stays, held, running, toast.id]);

    const run = (id: string, action: () => void | Promise<void>) => {
        if (running != null) {
            return;
        }
        setRunning(id);
        fireAndForget(async () => {
            try {
                await action();
            } finally {
                setRunning(null);
            }
        });
    };

    const body = (
        <>
            <div className="truncate text-12 font-semibold text-primary" title={plainInlineText(toast.title)}>
                <InlineCodeText text={toast.title} />
            </div>
            {toast.message ? (
                <div className="mt-0.5 line-clamp-2 text-12 text-secondary" title={plainInlineText(toast.message)}>
                    <InlineCodeText text={toast.message} />
                </div>
            ) : null}
        </>
    );

    return (
        <div
            role={toast.kind === "error" ? "alert" : "status"}
            data-testid="toast"
            data-tone={tone.tone}
            className="molten-toast pointer-events-auto relative flex items-start gap-2.5 rounded-10 border border-line-strong bg-surface-3 py-2.5 pr-2 pl-3 text-12 shadow-e2"
            onPointerEnter={() => setHeld(true)}
            onPointerLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setHeld(false);
                }
            }}
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    model.dismiss(toast.id, "user");
                }
            }}
        >
            {toast.thumbnail && !thumbFailed ? (
                <img
                    src={toast.thumbnail}
                    alt=""
                    draggable={false}
                    data-role="toast-thumbnail"
                    onError={() => setThumbFailed(true)}
                    className="h-8 w-8 shrink-0 rounded-6 object-cover"
                />
            ) : (
                <i
                    aria-hidden
                    className={cn(
                        "fa fa-solid mt-px w-3.5 shrink-0 text-center text-icon-14",
                        `fa-${tone.icon}`,
                        tone.colorClass
                    )}
                />
            )}
            <span className="sr-only">{tone.label}: </span>
            <div className="min-w-0 flex-1">
                {toast.onOpen ? (
                    <button
                        type="button"
                        onClick={() => run("open", toast.onOpen)}
                        className="block w-full min-w-0 cursor-pointer rounded-4 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                        {body}
                    </button>
                ) : (
                    body
                )}
                {toast.actions.length > 0 ? (
                    <div className="mt-2 -ml-1 flex items-center gap-1">
                        {toast.actions.map((action, i) => (
                            <button
                                key={action.id}
                                type="button"
                                disabled={running != null}
                                onClick={() => run(action.id, action.run)}
                                className={i === 0 ? FirstActionClass : OtherActionClass}
                            >
                                {running === action.id ? "Running…" : action.label}
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
            <button
                type="button"
                aria-label="Dismiss"
                title="Dismiss"
                onClick={() => model.dismiss(toast.id, "user")}
                className="molten-btn-ghost -mt-0.5 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-muted hover:text-primary"
            >
                <i aria-hidden className="fa fa-solid fa-xmark text-icon-14" />
            </button>
        </div>
    );
}

export function ToastStack({ onOpenCenter }: { onOpenCenter: () => void }) {
    const model = Toasts.getInstance();
    const stack = useAtomValue(model.stackAtom, { store: globalStore });
    const collapsed = useAtomValue(model.collapsedAtom, { store: globalStore });
    return (
        <div
            data-testid="toast-stack"
            aria-label="Notifications"
            className="molten-toast-stack pointer-events-none fixed right-4 bottom-10 z-[9400] flex w-[360px] max-w-[calc(100vw-32px)] flex-col items-stretch gap-2"
        >
            {collapsed > 0 && stack.length > 0 ? (
                <button
                    type="button"
                    onClick={onOpenCenter}
                    className="molten-btn-ghost pointer-events-auto cursor-pointer self-end rounded-6 px-2 py-0.5 text-11 text-muted hover:text-primary"
                >
                    {collapsed} more in Notifications
                </button>
            ) : null}
            {stack.map((toast) => (
                <ToastItem key={toast.id} toast={toast} />
            ))}
        </div>
    );
}
