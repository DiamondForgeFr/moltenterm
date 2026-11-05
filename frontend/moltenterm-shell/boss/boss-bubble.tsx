// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The foreman's bubble, the pennant and the hover peek (FR-BOSS-001, DS-BOSS-001): a round bubble of 44 px with his still
// portrait, framed on his head, at the bottom right of the window, draggable; folded, a pennant hanging from the top
// edge with his initial. On hover or keyboard focus the round opens into a comm screen toward the inside of the window
// (AC12, boss-screen.ts), where his animated portrait plays the loop of his pose (FR-BOSS-007). A badge counts the
// agents that wait or failed in every workspace, one cue plays when the count rises (the pennant waves; the round makes
// one gesture, the call, with his animated portrait), and the peek shows on hover without taking the focus. Nothing
// here opens anything by itself or plays a sound: the click on the bubble or the pennant, and nothing else, shows the
// Sessions card (FR-BOSS-002), and the same click hides it again.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { isMacOS } from "@/util/platformutil";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useId, useRef, useState } from "react";
import { AgentStateDotClasses, agentStateLabel } from "../agent-state-model";
import { useT, useTCount } from "../i18n/i18n";
import { MotionClass } from "../molten-motion";
import { openSettingsSection } from "../settings/settings-open";
import "./boss-bubble.css";
import { BossCard } from "./boss-card";
import { bossInitial } from "./boss-name";
import { BossPeek, bubbleLabel, peekIsQuiet, workplaceNames } from "./boss-overview";
import {
    Area,
    BubbleMarginPx,
    BubbleSizePx,
    cardStyle,
    clampRect,
    DefaultPlace,
    PeekGapPx,
    peekStyle,
    pennantCardStyle,
    PennantHeightPx,
    pennantRightPx,
    placeStyle,
    Rect,
} from "./boss-place";
import { BossPortrait } from "./boss-portrait";
import { BossScreen } from "./boss-screen";
import { holdAfter, NoScreenHold, ScreenEvent, screenShows, ScreenSizePx } from "./boss-screen-model";
import { BossBubbleModel } from "./boss-store";
import { BrokkExpressionsModel } from "./brokk-expressions";
import { useBubbleLive } from "./use-brokk-live";

// Under the pointer for this long before the peek shows: passing over the bubble shows nothing.
export const PeekDelayMs = 350;
// A press that moves less than this is a click, not a drag.
const DragThresholdPx = 4;
// The longest cue (the pennant's wave, 800 ms) and a margin.
const CueMaxMs = 1000;

function Title({ children }: { children: string }) {
    return <div className="mb-1 text-11 font-semibold tracking-wide text-muted uppercase">{children}</div>;
}

function PeekBody({ peek, name }: { peek: BossPeek; name: string }) {
    const t = useT();
    const tCount = useTCount();
    return (
        <div className="flex flex-col gap-2.5 text-12 text-primary">
            <div className="font-semibold">{name}</div>
            {peekIsQuiet(peek) ? <div className="text-secondary">{t("boss.peek.quiet")}</div> : null}
            {peek.waiting.length > 0 ? (
                <div data-testid="boss-peek-waiting">
                    <Title>{t("boss.peek.waitingTitle")}</Title>
                    <ul className="flex flex-col gap-1">
                        {peek.waiting.map((row) => (
                            <li key={row.id} className="flex items-center gap-2">
                                <span
                                    aria-hidden
                                    className={cn(
                                        "inline-block h-2 w-2 shrink-0 rounded-full",
                                        AgentStateDotClasses[row.state]
                                    )}
                                />
                                <span className="min-w-0 flex-1 truncate">
                                    <span className="font-medium">{row.name}</span>
                                    {row.workspace ? (
                                        <span className="text-secondary">{` · ${row.workspace}`}</span>
                                    ) : null}
                                </span>
                                <span className="shrink-0 text-muted">{agentStateLabel(row.state)}</span>
                            </li>
                        ))}
                        {peek.waitingMore > 0 ? (
                            <li className="text-muted">{tCount("boss.peek.more", peek.waitingMore)}</li>
                        ) : null}
                    </ul>
                </div>
            ) : null}
            {peek.working.length > 0 ? (
                <div data-testid="boss-peek-working">
                    <Title>{t("boss.peek.workingTitle")}</Title>
                    <ul className="flex flex-col gap-1">
                        {peek.working.map((place) => (
                            <li key={place.workspace + place.names.join()} className="flex gap-2">
                                {place.workspace ? (
                                    <span className="max-w-[40%] shrink-0 truncate font-medium">{place.workspace}</span>
                                ) : null}
                                <span className="min-w-0 flex-1 truncate text-secondary">{workplaceNames(place)}</span>
                            </li>
                        ))}
                        {peek.workingMore > 0 ? (
                            <li className="text-muted">{tCount("boss.peek.moreWorkspaces", peek.workingMore)}</li>
                        ) : null}
                    </ul>
                </div>
            ) : null}
            {peek.usage ? (
                <div data-testid="boss-peek-usage">
                    <Title>{t("boss.peek.usageTitle")}</Title>
                    <div className="text-secondary">{peek.usage}</div>
                </div>
            ) : null}
            {peek.latest ? (
                <div data-testid="boss-peek-latest">
                    <Title>{t("boss.peek.latestTitle")}</Title>
                    <div className="line-clamp-1 font-medium [overflow-wrap:anywhere]">{peek.latest.title}</div>
                    {peek.latest.message ? (
                        <div className="line-clamp-2 text-secondary [overflow-wrap:anywhere]">
                            {peek.latest.message}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

type DragState = {
    id: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
    area: Area;
    moved: boolean;
};

function BossBubbleLayer() {
    const t = useT();
    const model = BossBubbleModel.getInstance();
    const name = useAtomValue(model.nameAtom, { store: globalStore });
    const state = useAtomValue(model.stateAtom, { store: globalStore });
    const collapsed = useAtomValue(model.collapsedAtom, { store: globalStore });
    const dragRect = useAtomValue(model.dragAtom, { store: globalStore });
    const badge = useAtomValue(model.badgeAtom, { store: globalStore });
    const cue = useAtomValue(model.cueAtom, { store: globalStore });
    const peekOpen = useAtomValue(model.peekOpenAtom, { store: globalStore });
    const screenHold = useAtomValue(model.screenHoldAtom, { store: globalStore });
    const cardOpen = useAtomValue(model.cardOpenAtom, { store: globalStore });
    const peek = useAtomValue(model.peekAtom, { store: globalStore });
    const screenOpen = !collapsed && screenShows(screenHold, { dragging: dragRect != null, cardOpen });
    const live = useBubbleLive({ name, collapsed, screenOpen });
    const layerRef = useRef<HTMLDivElement>(null);
    const bubbleRef = useRef<HTMLButtonElement>(null);
    const drag = useRef<DragState>(null);
    const clickAfterDrag = useRef(false);
    const peekTimer = useRef<ReturnType<typeof setTimeout>>(null);
    const [swapAnimates, setSwapAnimates] = useState(false);
    // The last rise whose cue has played: a bubble drawn anew (a fold, an unfold, the window starting) does not play it
    // again.
    const [cuePlayed, setCuePlayed] = useState(cue);
    const descriptionId = useId();

    useEffect(() => model.attach(document), [model]);
    useEffect(() => BrokkExpressionsModel.getInstance().watch(), []);
    useEffect(() => {
        model.setRectSource(() => {
            const box = bubbleRef.current?.getBoundingClientRect();
            return box == null ? null : { left: box.left, top: box.top, width: box.width, height: box.height };
        });
        return () => model.setRectSource(null);
    }, [model]);
    // A bubble that appears with the window stands still; only a fold or an unfold moves.
    const firstCollapsed = useRef(collapsed);
    useEffect(() => {
        if (collapsed !== firstCollapsed.current) {
            setSwapAnimates(true);
        }
    }, [collapsed]);
    useEffect(() => () => clearTimeout(peekTimer.current), []);
    // A fold or an unfold draws the other button, which the pointer has not reached: the delay still running for the
    // one that left must not show the peek for the new one, nor what held the screen open for the one that went.
    useEffect(() => {
        clearTimeout(peekTimer.current);
        globalStore.set(model.peekOpenAtom, false);
        globalStore.set(model.screenHoldAtom, NoScreenHold);
    }, [collapsed, model]);

    const label = bubbleLabel(name, badge.count);
    const cueClass = cue > cuePlayed ? (cue % 2 === 1 ? "mt-boss-cue-a" : "mt-boss-cue-b") : "";
    // The animation's end says the cue played; this covers a motion that never runs (reduced motion, a hidden window),
    // so the cue does not wait to play at some later time.
    useEffect(() => {
        if (cue <= cuePlayed) {
            return;
        }
        const timer = setTimeout(() => setCuePlayed(cue), CueMaxMs);
        return () => clearTimeout(timer);
    }, [cue, cuePlayed]);
    const onAnimationEnd = (e: React.AnimationEvent) => {
        if (e.target === e.currentTarget && e.animationName.startsWith("mt-boss-")) {
            setCuePlayed(cue);
        }
    };

    const closePeek = () => {
        clearTimeout(peekTimer.current);
        globalStore.set(model.peekOpenAtom, false);
    };
    const holdScreen = (event: ScreenEvent) => {
        const hold = globalStore.get(model.screenHoldAtom);
        const next = holdAfter(hold, event);
        if (next !== hold) {
            globalStore.set(model.screenHoldAtom, next);
        }
    };
    const openPeekSoon = (delayMs: number = PeekDelayMs) => {
        clearTimeout(peekTimer.current);
        if (drag.current?.moved || globalStore.get(model.cardOpenAtom)) {
            return;
        }
        peekTimer.current = setTimeout(() => globalStore.set(model.peekOpenAtom, true), delayMs);
    };

    const showMenu = (e: React.MouseEvent, items: ContextMenuItem[]) => {
        e.preventDefault();
        e.stopPropagation();
        closePeek();
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };
    const settingsItem: ContextMenuItem = {
        label: t("boss.menu.settings", { name }),
        click: () => void openSettingsSection("boss"),
    };
    const bubbleMenu: ContextMenuItem[] = [
        { label: t("boss.menu.collapse", { name }), click: () => model.collapse() },
        {
            label: t("boss.menu.resetPosition"),
            enabled:
                state.place.corner !== DefaultPlace.corner ||
                state.place.dx !== DefaultPlace.dx ||
                state.place.dy !== DefaultPlace.dy,
            click: () => model.resetPosition(),
        },
        { type: "separator" },
        settingsItem,
    ];
    const pennantMenu: ContextMenuItem[] = [
        { label: t("boss.menu.showBubble"), click: () => model.expand() },
        { type: "separator" },
        settingsItem,
    ];

    // A press that stays put is a click; one that moves is a drag, dropped at the nearest corner's offset.
    const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0 || layerRef.current == null) {
            return;
        }
        const layer = layerRef.current.getBoundingClientRect();
        const box = e.currentTarget.getBoundingClientRect();
        clickAfterDrag.current = false;
        drag.current = {
            id: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            left: box.left - layer.left,
            top: box.top - layer.top,
            area: { width: layer.width, height: layer.height },
            moved: false,
        };
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // A pointer that is already gone has nothing to follow.
        }
    };
    const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
        const d = drag.current;
        if (d == null || e.pointerId !== d.id) {
            return;
        }
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (!d.moved && Math.hypot(dx, dy) < DragThresholdPx) {
            return;
        }
        if (!d.moved) {
            d.moved = true;
            closePeek();
            holdScreen("reset");
            model.closeCard();
        }
        const next: Rect = clampRect(
            { left: d.left + dx, top: d.top + dy, width: BubbleSizePx, height: BubbleSizePx },
            d.area
        );
        globalStore.set(model.dragAtom, next);
    };
    const endDrag = (e: React.PointerEvent<HTMLButtonElement>, dropped: boolean) => {
        const d = drag.current;
        if (d == null || e.pointerId !== d.id) {
            return;
        }
        drag.current = null;
        try {
            e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
            // Already released with the pointer.
        }
        if (!d.moved) {
            return;
        }
        clickAfterDrag.current = true;
        const rect = globalStore.get(model.dragAtom);
        if (dropped && rect != null) {
            model.drop(rect, d.area);
        }
        globalStore.set(model.dragAtom, null);
    };

    // The click shows the card, or hides it again; the peek, which the pointer on the button had brought, gives way.
    const onActivate = () => {
        if (clickAfterDrag.current) {
            clickAfterDrag.current = false;
            return;
        }
        closePeek();
        model.toggleCard();
    };
    const hover = {
        onPointerEnter: () => openPeekSoon(),
        onPointerLeave: closePeek,
        onFocus: (e: React.FocusEvent<HTMLElement>) => {
            if (e.currentTarget.matches(":focus-visible")) {
                openPeekSoon();
            }
        },
        onBlur: closePeek,
        // A press on the bubble must not move the focus out of the terminal he types in.
        onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
        onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Escape" && peekOpen) {
                e.stopPropagation();
                closePeek();
            }
        },
    };

    // The bubble adds the comm screen's hold to the same events. Only the round at rest takes the pointer in; once the
    // screen is open its zone takes it (boss-bubble.css), and the leave of the whole button, which the zone is part of,
    // is the pointer going out of the screen. A touch is not a hover.
    const bubbleHover = {
        ...hover,
        onPointerEnter: (e: React.PointerEvent) => {
            hover.onPointerEnter();
            if (e.pointerType !== "touch") {
                holdScreen("pointer-enter");
            }
        },
        onPointerLeave: () => {
            hover.onPointerLeave();
            holdScreen("pointer-leave");
        },
        onFocus: (e: React.FocusEvent<HTMLElement>) => {
            hover.onFocus(e);
            if (e.currentTarget.matches(":focus-visible")) {
                holdScreen("focus");
            }
        },
        onBlur: () => {
            hover.onBlur();
            holdScreen("blur");
        },
        onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key !== "Escape" || !(screenOpen || peekOpen)) {
                return;
            }
            e.stopPropagation();
            closePeek();
            holdScreen("dismiss");
        },
    };

    const swap = swapAnimates ? MotionClass.arrive : "";
    const pennantRight = pennantRightPx(isMacOS());
    const shownPlace = state.place;
    const bubbleStyle = dragRect != null ? { left: dragRect.left, top: dragRect.top } : placeStyle(shownPlace);

    return (
        <div ref={layerRef} className="mt-boss-layer" data-testid="boss-layer">
            {collapsed ? (
                <button
                    key="pennant"
                    type="button"
                    className={cn("mt-boss-pennant", swap, cueClass)}
                    style={{ right: pennantRight }}
                    aria-label={label}
                    aria-describedby={descriptionId}
                    aria-haspopup="dialog"
                    aria-expanded={cardOpen}
                    data-testid="boss-pennant"
                    data-boss-anchor=""
                    onClick={() => {
                        closePeek();
                        model.toggleCard();
                    }}
                    onContextMenu={(e) => showMenu(e, pennantMenu)}
                    onAnimationEnd={onAnimationEnd}
                    {...hover}
                >
                    <span className="mt-boss-flag" aria-hidden />
                    <span className="mt-boss-initial" aria-hidden>
                        {bossInitial(name)}
                    </span>
                    {badge.count > 0 ? (
                        <span className="mt-boss-badge" data-tone={badge.tone} data-testid="boss-badge" aria-hidden>
                            {badge.text}
                        </span>
                    ) : null}
                </button>
            ) : (
                <button
                    key="bubble"
                    ref={bubbleRef}
                    type="button"
                    className={cn("mt-boss-bubble", swap, dragRect != null && "is-dragging")}
                    style={bubbleStyle}
                    aria-label={label}
                    aria-describedby={descriptionId}
                    aria-haspopup="dialog"
                    aria-expanded={cardOpen}
                    data-testid="boss-bubble"
                    data-boss-anchor=""
                    data-corner={shownPlace.corner}
                    data-screen={screenOpen ? "open" : "rest"}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={(e) => endDrag(e, true)}
                    onPointerCancel={(e) => endDrag(e, false)}
                    onClick={onActivate}
                    onContextMenu={(e) => showMenu(e, bubbleMenu)}
                    {...bubbleHover}
                >
                    <span className="mt-boss-shape" data-testid="boss-shape" aria-hidden>
                        <span className="mt-boss-face">
                            <BossPortrait live={live} />
                            {screenOpen ? <BossScreen name={name} count={badge.count} /> : null}
                        </span>
                        {badge.count > 0 ? (
                            <span className="mt-boss-badge" data-tone={badge.tone} data-testid="boss-badge" aria-hidden>
                                {badge.text}
                            </span>
                        ) : null}
                    </span>
                    <span className="mt-boss-zone" data-testid="boss-zone" aria-hidden />
                </button>
            )}
            {/* The peek as the button's description, for screen readers (AC10); the visual one below is the same text. */}
            <div id={descriptionId} className="sr-only" data-testid="boss-description">
                <PeekBody peek={peek} name={name} />
            </div>
            {cardOpen && dragRect == null ? (
                <BossCard style={collapsed ? pennantCardStyle(pennantRight) : cardStyle(shownPlace)} />
            ) : null}
            {peekOpen && !cardOpen && dragRect == null ? (
                <div
                    aria-hidden
                    data-testid="boss-peek"
                    className="mt-boss-peek rounded-4 border border-line-strong bg-surface-3 px-3 py-2.5 shadow-e2"
                    style={
                        collapsed
                            ? { top: PennantHeightPx + PeekGapPx, right: pennantRight }
                            : peekStyle(
                                  shownPlace,
                                  BubbleSizePx,
                                  BubbleMarginPx,
                                  screenOpen ? ScreenSizePx - BubbleSizePx : 0
                              )
                    }
                >
                    <PeekBody peek={peek} name={name} />
                </div>
            ) : null}
        </div>
    );
}

// The bubble of the window, or nothing when Settings turned it off (AC9): then no pennant shows either, and nothing
// listens.
export function BossBubbleHost() {
    const show = useAtomValue(BossBubbleModel.getInstance().showAtom, { store: globalStore });
    return show ? <BossBubbleLayer /> : null;
}
