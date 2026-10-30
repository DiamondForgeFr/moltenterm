// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The toast stack (FR-SHELL-055, DS-SHELL-097): it comes from the notification bell (#1403), top left under the bell's
// row and right of the sidebar (toastStackPlace), 360 px wide, the newest nearest the bell. A toast drops in in 240 ms
// (instant under reduced motion), leaves by itself after 6 s unless it waits for a gesture, and holds while pointed at
// or focused. A notification's toast that times out shrinks into the bell, where its notification waits. Escape
// dismisses the focused toast.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { labelled, useT } from "./i18n/i18n";
import { InlineCodeText, plainInlineText } from "./inline-code";
import { bellOrder, Toast, ToastDismissMs, ToastStackPlace, toastStackPlace, ToastText, toneOf } from "./toast-model";
import { Toasts } from "./toast-store";
import "./toast.css";

// The labels wrap inside their buttons and the buttons wrap to a new row: a fixed height let a two-line French label
// spill out of its button (#1403).
const ActionClass =
    "min-h-6 max-w-full cursor-pointer rounded-6 px-2 py-0.5 text-left text-12 leading-4 whitespace-normal [overflow-wrap:anywhere] disabled:opacity-60";
const FirstActionClass = cn(ActionClass, "molten-btn-secondary bg-line font-medium text-primary");
const OtherActionClass = cn(ActionClass, "molten-btn-ghost text-secondary hover:text-primary");
const FlightFallbackMs = 600;
const DefaultFrameGapPx = 8;

type Flight = { x: number; y: number };

function ToastItem({ toast, bellRef }: { toast: Toast; bellRef?: React.RefObject<HTMLElement> }) {
    const t = useT();
    const model = Toasts.getInstance();
    const tone = toneOf(toast.kind);
    const [running, setRunning] = useState<string>(null);
    const [held, setHeld] = useState(false);
    const [thumbFailed, setThumbFailed] = useState(false);
    const [flight, setFlight] = useState<Flight>(null);
    const remaining = useRef(toast.dismissMs ?? ToastDismissMs);
    const started = useRef(0);
    const rootRef = useRef<HTMLDivElement>(null);

    // Only a notification's toast flies into the bell: the center keeps its notification. Another toast has nothing
    // waiting there, so it simply goes.
    const timeOut = () => {
        const bell = bellRef?.current?.getBoundingClientRect();
        const own = rootRef.current?.getBoundingClientRect();
        if (toast.notificationId == null || bell == null || own == null || bell.right <= 0) {
            model.dismiss(toast.id, "timeout");
            return;
        }
        setFlight({ x: bell.left + bell.width / 2 - own.left, y: bell.top + bell.height / 2 - own.top });
    };

    // The countdown restarts where it stopped: a toast pointed at for a while still gets the rest of its time.
    useEffect(() => {
        if (toast.stays || held || running != null || flight != null) {
            return;
        }
        started.current = Date.now();
        const timer = setTimeout(timeOut, remaining.current);
        return () => {
            clearTimeout(timer);
            remaining.current = Math.max(1000, remaining.current - (Date.now() - started.current));
        };
    }, [toast.stays, held, running, toast.id, flight]);

    // The flight ends on its animation's end; this only covers an animation that never runs (a hidden window).
    useEffect(() => {
        if (flight == null) {
            return;
        }
        const timer = setTimeout(() => model.dismiss(toast.id, "timeout"), FlightFallbackMs);
        return () => clearTimeout(timer);
    }, [flight, toast.id]);

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

    const shown = toast.text ? toast.text() : toast;
    const body = (
        <>
            <div
                className="line-clamp-2 text-12 font-semibold text-primary [overflow-wrap:anywhere]"
                title={plainInlineText(shown.title)}
            >
                <InlineCodeText text={shown.title} />
            </div>
            {shown.message ? (
                <div
                    className="mt-0.5 line-clamp-3 text-12 text-secondary [overflow-wrap:anywhere]"
                    title={plainInlineText(shown.message)}
                >
                    <InlineCodeText text={shown.message} />
                </div>
            ) : null}
        </>
    );

    return (
        <div
            ref={rootRef}
            role={toast.kind === "error" ? "alert" : "status"}
            data-testid="toast"
            data-tone={tone.tone}
            data-flight={flight != null ? "bell" : undefined}
            className={cn(
                "molten-toast pointer-events-auto relative flex items-start gap-2.5 rounded-4 border border-line-strong bg-surface-3 py-2.5 pr-2 pl-3 text-12 shadow-e2",
                flight != null && "molten-toast-to-bell pointer-events-none"
            )}
            style={
                flight != null
                    ? ({
                          "--mt-toast-to-x": `${flight.x}px`,
                          "--mt-toast-to-y": `${flight.y}px`,
                      } as React.CSSProperties)
                    : undefined
            }
            onAnimationEnd={(e) => {
                if (flight != null && e.animationName === "molten-toast-to-bell") {
                    model.dismiss(toast.id, "timeout");
                }
            }}
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
            <span className="sr-only">{labelled(tone.label, "")}</span>
            <div className="min-w-0 flex-1">
                {toast.onOpen ? (
                    <button
                        type="button"
                        onClick={() => run("open", toast.onOpen)}
                        className="block w-full min-w-0 cursor-pointer rounded-4 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mt-focus-ring)"
                    >
                        {body}
                    </button>
                ) : (
                    body
                )}
                {toast.actions.length > 0 ? (
                    <div className="mt-2 -ml-1 flex flex-wrap items-center gap-1">
                        {toast.actions.map((action, i) => (
                            <button
                                key={action.id}
                                type="button"
                                disabled={running != null}
                                onClick={() => run(action.id, action.run)}
                                className={i === 0 ? FirstActionClass : OtherActionClass}
                            >
                                {running === action.id
                                    ? t("notif.center.running")
                                    : ((shown as ToastText).actionLabels?.[action.id] ?? action.label)}
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
            <button
                type="button"
                aria-label={t("common.dismiss")}
                title={t("common.dismiss")}
                onClick={() => model.dismiss(toast.id, "user")}
                className="molten-btn-ghost -mt-0.5 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-muted hover:text-primary"
            >
                <i aria-hidden className="fa fa-solid fa-xmark text-icon-14" />
            </button>
        </div>
    );
}

function measurePlace(bell: HTMLElement): ToastStackPlace {
    if (typeof window === "undefined") {
        return toastStackPlace({ windowWidth: 1280, frameGap: DefaultFrameGapPx });
    }
    const sidebar = bell?.closest<HTMLElement>('[data-testid="workspace-sidebar"]');
    const gap = parseFloat(getComputedStyle(sidebar ?? document.documentElement).getPropertyValue("--mt-frame-gap"));
    const bellRect = bell?.getBoundingClientRect();
    return toastStackPlace({
        windowWidth: window.innerWidth,
        frameGap: Number.isFinite(gap) ? gap : DefaultFrameGapPx,
        bellBottom: bellRect?.bottom,
        bellRight: bellRect?.right,
        sidebarRight: sidebar?.getBoundingClientRect().right,
    });
}

// Follows the bell while toasts show: the window's width, the sidebar's width, and the sidebar hiding, floating in or
// sliding out (its class, then the end of its slide).
function useStackPlace(bellRef: React.RefObject<HTMLElement>, active: boolean): ToastStackPlace {
    const [place, setPlace] = useState<ToastStackPlace>(() => measurePlace(bellRef?.current));
    useLayoutEffect(() => {
        if (!active) {
            return;
        }
        const update = () => setPlace(measurePlace(bellRef?.current));
        update();
        const sidebar = bellRef?.current?.closest<HTMLElement>('[data-testid="workspace-sidebar"]');
        window.addEventListener("resize", update);
        const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
        const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
        if (sidebar != null) {
            resize?.observe(sidebar);
            mutation?.observe(sidebar, { attributes: true, attributeFilter: ["class", "data-hidden"] });
            sidebar.addEventListener("transitionend", update);
        }
        return () => {
            window.removeEventListener("resize", update);
            resize?.disconnect();
            mutation?.disconnect();
            sidebar?.removeEventListener("transitionend", update);
        };
    }, [active, bellRef]);
    return place;
}

export function ToastStack({
    onOpenCenter,
    bellRef,
}: {
    onOpenCenter: () => void;
    bellRef?: React.RefObject<HTMLElement>;
}) {
    const t = useT();
    const model = Toasts.getInstance();
    const stack = useAtomValue(model.stackAtom, { store: globalStore });
    const collapsed = useAtomValue(model.collapsedAtom, { store: globalStore });
    const place = useStackPlace(bellRef, stack.length > 0);
    return (
        <div
            data-testid="toast-stack"
            aria-label={t("notif.center.title")}
            style={{ top: place.top, left: place.left, width: place.width }}
            className="molten-toast-stack pointer-events-none fixed z-[9400] flex flex-col items-stretch gap-2"
        >
            {bellOrder(stack).map((toast) => (
                <ToastItem key={toast.id} toast={toast} bellRef={bellRef} />
            ))}
            {collapsed > 0 && stack.length > 0 ? (
                <button
                    type="button"
                    onClick={onOpenCenter}
                    className="molten-btn-ghost pointer-events-auto cursor-pointer self-start rounded-6 px-2 py-0.5 text-11 text-muted hover:text-primary"
                >
                    {t("notif.toast.moreInCenter", { count: collapsed })}
                </button>
            ) : null}
        </div>
    );
}
