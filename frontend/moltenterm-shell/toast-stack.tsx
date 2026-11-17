// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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
import { DominoLoader } from "./suite/suite";
import {
    bellOrder,
    PlaceRect,
    Toast,
    ToastDismissMs,
    ToastFlight,
    toastFlightTarget,
    toastStackClear,
    ToastStackPlace,
    toastStackPlace,
    ToastText,
    toneOf,
} from "./toast-model";
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

type Flight = ToastFlight;

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
        // His group open, the flight to his face would cross it (#2241): the toast simply goes, its notification is listed.
        const groupOpen = document.querySelector(".mt-brokk-group.is-in") != null;
        if (toast.notificationId == null || bell == null || own == null || bell.right <= 0 || groupOpen) {
            model.dismiss(toast.id, "timeout", toast);
            return;
        }
        setFlight(toastFlightTarget(bell, own));
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
        const timer = setTimeout(() => model.dismiss(toast.id, "timeout", toast), FlightFallbackMs);
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
                    model.dismiss(toast.id, "timeout", toast);
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
                    model.dismiss(toast.id, "user", toast);
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
                                {running === action.id ? <DominoLoader className="mr-1.5" /> : null}
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
                onClick={() => model.dismiss(toast.id, "user", toast)}
                className="molten-btn-ghost -mt-0.5 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-muted hover:text-primary"
            >
                <i aria-hidden className="fa fa-solid fa-xmark text-icon-14" />
            </button>
        </div>
    );
}

// What Brokk stands on (#2241): every face of his, his open group and what it holds, and his visit's scene.
export const BrokkSurfaceSelector =
    "[data-brokk-avatar], .mt-brokk-group.is-in, .mt-brokk-group.is-in > *, [data-testid='brokk-scene']";

// A surface over most of the window is a catcher of the pointer, not something to see: it is no obstacle.
const CatcherShare = 0.5;

function brokkSurfaces(): PlaceRect[] {
    const area = window.innerWidth * window.innerHeight;
    return [...document.querySelectorAll<HTMLElement>(BrokkSurfaceSelector)]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0 && r.width * r.height < area * CatcherShare)
        .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
}

function measurePlace(bell: HTMLElement, stackHeight: number): ToastStackPlace {
    if (typeof window === "undefined") {
        return toastStackPlace({ windowWidth: 1280, frameGap: DefaultFrameGapPx });
    }
    const sidebar = bell?.closest<HTMLElement>('[data-testid="workspace-sidebar"]');
    const gap = parseFloat(getComputedStyle(sidebar ?? document.documentElement).getPropertyValue("--mt-frame-gap"));
    const bellRect = bell?.getBoundingClientRect();
    const frame = {
        windowWidth: window.innerWidth,
        frameGap: Number.isFinite(gap) ? gap : DefaultFrameGapPx,
        bellBottom: bellRect?.bottom,
        bellRight: bellRect?.right,
        sidebarRight: sidebar?.getBoundingClientRect().right,
    };
    return toastStackClear(toastStackPlace(frame), stackHeight, brokkSurfaces(), frame);
}

function samePlace(a: ToastStackPlace, b: ToastStackPlace): boolean {
    return a.top === b.top && a.left === b.left && a.width === b.width;
}

// Follows the bell while toasts show: the window's width, the sidebar's width, the sidebar hiding, floating in or
// sliding out (its class, then the end of its slide), and Brokk's surfaces opening, closing or moving (#2241): what
// changes in the page is read again once per frame.
function useStackPlace(
    bellRef: React.RefObject<HTMLElement>,
    stackRef: React.RefObject<HTMLElement>,
    active: boolean
): ToastStackPlace {
    const [place, setPlace] = useState<ToastStackPlace>(() => measurePlace(bellRef?.current, 0));
    useLayoutEffect(() => {
        if (!active) {
            return;
        }
        let frame: number = null;
        const measure = () => {
            frame = null;
            const next = measurePlace(bellRef?.current, stackRef?.current?.offsetHeight ?? 0);
            setPlace((current) => (samePlace(current, next) ? current : next));
        };
        const update = () => {
            if (frame == null) {
                frame = requestAnimationFrame(measure);
            }
        };
        measure();
        window.addEventListener("resize", update);
        document.addEventListener("transitionend", update, true);
        document.addEventListener("animationend", update, true);
        const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
        const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
        const sidebar = bellRef?.current?.closest<HTMLElement>('[data-testid="workspace-sidebar"]');
        if (sidebar != null) {
            resize?.observe(sidebar);
        }
        if (stackRef?.current != null) {
            resize?.observe(stackRef.current);
        }
        mutation?.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class", "data-hidden", "data-shown"],
        });
        return () => {
            if (frame != null) {
                cancelAnimationFrame(frame);
            }
            window.removeEventListener("resize", update);
            document.removeEventListener("transitionend", update, true);
            document.removeEventListener("animationend", update, true);
            resize?.disconnect();
            mutation?.disconnect();
        };
    }, [active, bellRef, stackRef]);
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
    const stackRef = useRef<HTMLDivElement>(null);
    const place = useStackPlace(bellRef, stackRef, stack.length > 0);
    return (
        <div
            ref={stackRef}
            data-testid="toast-stack"
            aria-label={t("notif.center.title")}
            style={{ top: place.top, left: place.left, width: place.width }}
            className="molten-toast-stack pointer-events-none fixed z-[9400] flex flex-col items-stretch gap-2"
        >
            {bellOrder(stack).map((toast) => (
                <ToastItem key={`${toast.id}:${toast.revision}`} toast={toast} bellRef={bellRef} />
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
