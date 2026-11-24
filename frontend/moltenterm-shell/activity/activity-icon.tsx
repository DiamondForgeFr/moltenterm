// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The activity indicator of the title row (FR-BOSS-009, AC85, #2233, #2294): a 28 px slot on the left of Brokk's face
// that says what runs, from the activity source. Nothing runs: the flame put out. One item runs: the icon of its panel
// in a ring that turns. Several run: the flame lit in the same ring. An agent that waits for the developer is a state of
// its own: the agent's icon in a complete ring that breathes, in the waiting colour; when something runs too, the
// running drawing stays and a haloed dot sits on the corner. Hovering it opens the detail by group, a click or Enter
// holds the detail open, and a click on a row goes to that item's place. The drawing is in activity-icon.css.

import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { autoUpdate, FloatingPortal, offset, shift } from "@floating-ui/react";
import { Activity } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MachineLoad } from "../agent-state-model";
import { useFloatingInPlace } from "../floating-in-place";
import { useT, useTCount } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import { useMinuteNow } from "../reviews/reviews-agent-bar";
import { durationText } from "../reviews/reviews-upcoming-model";
import { DominoLoader } from "../suite/suite";
import "./activity-icon.css";
import { showsLoadWarning, useMachineLoad } from "./activity-load";
import {
    activityGlyph,
    ActivityGlyph,
    ActivityGlyphIcons,
    activityGroups,
    activityPopoverTitle,
    ActivityRow,
    ActivitySubRow,
    ActivitySummary,
    ActivityTarget,
    activityTexts,
    ActivityWords,
} from "./activity-model";
import { openActivity } from "./activity-open";
import { useActivity } from "./activity-store";

export const ActivityOpenDelayMs = 150;
export const ActivityCloseDelayMs = 250;

// The ring and the glyph: a 28 px box, the ring 24 px across, the glyph centred in it. An agent that waits while
// something runs has the waiting state's haloed dot on the corner (waits); with nothing running the ring itself is the
// mark (the "wait" glyph: a complete ring, no arc).
export function ActivityMark({ glyph, waits = false }: { glyph: ActivityGlyph; waits?: boolean }) {
    const running = glyph !== "idle" && glyph !== "wait";
    return (
        <>
            <svg className="mt-act-ring" viewBox="0 0 28 28" aria-hidden data-testid="activity-ring">
                <circle className="mt-act-track" cx="14" cy="14" r="12" />
                {running ? <circle className="mt-act-arc" cx="14" cy="14" r="12" /> : null}
            </svg>
            <i className={cn(makeIconClass(ActivityGlyphIcons[glyph], true), "mt-act-glyph")} aria-hidden />
            {waits && running ? <span className="mt-act-pip" aria-hidden data-testid="activity-pip" /> : null}
        </>
    );
}

// One sub-agent under its agent (#2502): its ticket and task with its age, then the dominoes, what it waits for and since
// when. A click goes to its agent, like the agent's own row.
function ActivitySubButton({
    sub,
    words,
    onGo,
}: {
    sub: ActivitySubRow;
    words: ActivityWords;
    onGo: (target: ActivityTarget) => void;
}) {
    const name = [[sub.ticket, sub.title].filter(Boolean).join(" "), sub.age, sub.waits, sub.job, sub.jobAge]
        .filter(Boolean)
        .join(", ");
    return (
        <button
            type="button"
            className="mt-act-sub"
            title={words.t(sub.whereKey)}
            aria-label={name}
            data-testid="activity-sub"
            data-waiting={sub.waits ? "" : undefined}
            onClick={() => onGo(sub.target)}
        >
            <span className="mt-act-sub-l1">
                {sub.ticket ? <span className="mt-act-sub-id">{sub.ticket}</span> : null}
                <span className="mt-act-sub-title">{sub.title}</span>
                {sub.age ? <span className="mt-act-sub-age">{sub.age}</span> : null}
            </span>
            <span className="mt-act-sub-l2">
                <DominoLoader className="mt-act-dom" />
                <span className="mt-act-sub-job" data-testid="activity-sub-job">
                    {sub.job}
                </span>
                {sub.jobAge ? <span className="mt-act-sub-since">{`· ${sub.jobAge}`}</span> : null}
            </span>
        </button>
    );
}

// The discreet strip of a loaded machine (#2502): the pulse glyph and one sentence, in the warm tone, never red.
export function ActivityLoadStrip({ words }: { words: ActivityWords }) {
    const text = words.t("activity.load.warning");
    return (
        <div className="mt-act-load" role="status" aria-label={text} data-testid="activity-load">
            <Activity size={13} strokeWidth={2} aria-hidden />
            <span>{text}</span>
        </div>
    );
}

// The detail by group: the title, then the agents each with its sub-agents under it, then what runs outside any agent,
// and the machine's load when it is high.
export function ActivityPopoverBody({
    summary,
    words,
    onGo,
    load,
}: {
    summary: ActivitySummary;
    words: ActivityWords;
    onGo: (row: ActivityRow) => void;
    load?: MachineLoad;
}) {
    const groups = activityGroups(summary, words);
    return (
        <>
            <div className="text-13 font-semibold text-primary" data-testid="activity-popover-title">
                {activityPopoverTitle(summary, words.t)}
            </div>
            {groups.map((group) => (
                <div key={group.id} className="mt-2.5 flex flex-col gap-0.5" data-testid={`activity-group-${group.id}`}>
                    <div
                        className={cn(
                            "pb-0.5 text-11 font-medium tracking-[0.06em] uppercase",
                            group.id === "waiting" ? "text-[var(--mt-state-waiting)]" : "text-muted"
                        )}
                    >
                        {group.title}
                    </div>
                    {group.rows.map((row) => (
                        <div key={row.id} className="mt-act-entry" data-testid="activity-entry">
                            <button
                                type="button"
                                className="-mx-1.5 flex cursor-pointer items-baseline justify-between gap-2.5 rounded-4 px-1.5 py-[3px] text-left text-12 text-primary transition-colors duration-120 ease-mt hover:bg-hover"
                                title={row.whereKey ? words.t(row.whereKey) : undefined}
                                data-testid="activity-row"
                                onClick={() => onGo(row)}
                            >
                                <span className="min-w-0 truncate">
                                    {row.what}
                                    {row.detail ? (
                                        <span
                                            className={cn(row.subs?.length > 0 ? "mt-act-sub-count" : "text-secondary")}
                                        >{` · ${row.detail}`}</span>
                                    ) : null}
                                </span>
                                <span className="shrink-0 whitespace-nowrap text-secondary tabular-nums">
                                    {row.since}
                                </span>
                            </button>
                            {row.subs?.length > 0 ? (
                                <div className="mt-act-subs" data-testid="activity-subs">
                                    {row.subs.map((sub) => (
                                        <ActivitySubButton
                                            key={sub.id}
                                            sub={sub}
                                            words={words}
                                            onGo={(target) => onGo({ ...row, target })}
                                        />
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    ))}
                </div>
            ))}
            {summary.count === 0 && summary.waiting.length === 0 ? (
                <div className="mt-2.5 text-12 text-secondary" data-testid="activity-popover-none">
                    {words.t("activity.popover.none")}
                </div>
            ) : null}
            {showsLoadWarning(load) ? <ActivityLoadStrip words={words} /> : null}
        </>
    );
}

function ActivityPopover({
    anchor,
    summary,
    focusFirst,
    onGo,
    onClose,
    onEnter,
    onLeave,
}: {
    anchor: HTMLElement;
    summary: ActivitySummary;
    // Opened from the keyboard: the focus goes to the first row, which the order of the page would not reach.
    focusFirst: boolean;
    onGo: (target: ActivityTarget) => void;
    onClose: () => void;
    onEnter: () => void;
    onLeave: () => void;
}) {
    const t = useT();
    const tc = useTCount();
    const now = useMinuteNow();
    const floatingRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (focusFirst) {
            floatingRef.current?.querySelector<HTMLElement>("[data-testid='activity-row']")?.focus();
        }
    }, [focusFirst]);
    // Every age of the popover reads as the sub-agents' and the companion's do: "7 min", "1 h 02".
    const words = useMemo<ActivityWords>(
        () => ({ t, tc, now, age: (startedat, at) => durationText(t, at - startedat), server: serverText }),
        [t, tc, now]
    );
    // Asked only while the popover shows: it unmounts with it.
    const load = useMachineLoad();
    const { refs, floatingStyles } = useFloatingInPlace({
        open: true,
        placement: "bottom-end",
        elements: { reference: anchor },
        middleware: [offset(6), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    return (
        <FloatingPortal>
            <div
                ref={(el) => {
                    refs.setFloating(el);
                    floatingRef.current = el;
                }}
                style={floatingStyles}
                className="z-[1000]"
                data-testid="activity-popover"
                onPointerEnter={onEnter}
                onPointerLeave={onLeave}
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        onClose();
                    }
                }}
            >
                <div
                    className="mt-sb-pop mt-act-pop flex flex-col rounded-4 px-3.5 py-3"
                    role="dialog"
                    aria-label={activityPopoverTitle(summary, t)}
                >
                    <ActivityPopoverBody summary={summary} words={words} onGo={(row) => onGo(row.target)} load={load} />
                </div>
            </div>
        </FloatingPortal>
    );
}

// The popover opens after the pointer rested on the slot a moment and closes a moment after it left both, so that a
// pass on the way to the window's buttons opens nothing and the way to a row loses nothing. A click or Enter holds it.
function useOpenIntent() {
    const [hovered, setHovered] = useState(false);
    const [pinned, setPinned] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout>>(null);
    const stop = useCallback(() => {
        if (timer.current != null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
    }, []);
    useEffect(() => stop, [stop]);
    const enter = useCallback(() => {
        stop();
        timer.current = setTimeout(() => setHovered(true), ActivityOpenDelayMs);
    }, [stop]);
    const leave = useCallback(() => {
        stop();
        timer.current = setTimeout(() => setHovered(false), ActivityCloseDelayMs);
    }, [stop]);
    const close = useCallback(() => {
        stop();
        setHovered(false);
        setPinned(false);
    }, [stop]);
    const toggle = useCallback(() => {
        stop();
        if (pinned) {
            setHovered(false);
            setPinned(false);
            return;
        }
        setHovered(true);
        setPinned(true);
    }, [pinned, stop]);
    return { open: hovered || pinned, pinned, enter, leave, close, toggle };
}

export function ActivityIcon() {
    const t = useT();
    const tc = useTCount();
    const summary = useActivity();
    const glyph = activityGlyph(summary);
    const texts = activityTexts(summary, t, tc);
    const [anchor, setAnchor] = useState<HTMLButtonElement>(null);
    const [byKeyboard, setByKeyboard] = useState(false);
    const intent = useOpenIntent();
    const { open, pinned, close } = intent;

    // A click outside the slot and its popover lets go of a held popover.
    useEffect(() => {
        if (!open || !pinned) {
            return;
        }
        const onDown = (e: PointerEvent) => {
            const target = e.target as Node;
            if (
                anchor?.contains(target) ||
                document.querySelector("[data-testid='activity-popover']")?.contains(target)
            ) {
                return;
            }
            close();
        };
        document.addEventListener("pointerdown", onDown, true);
        return () => document.removeEventListener("pointerdown", onDown, true);
    }, [open, pinned, anchor, close]);

    return (
        <>
            <button
                ref={setAnchor}
                type="button"
                className="mt-act rounded-6 transition-colors duration-120 ease-mt hover:bg-hover"
                data-testid="activity-icon"
                data-state={glyph === "wait" ? "waiting" : summary.count > 0 ? "running" : "idle"}
                data-waiting={summary.waiting.length > 0 ? "true" : undefined}
                data-glyph={glyph}
                aria-label={texts.label}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={(e) => {
                    setByKeyboard(e.detail === 0);
                    intent.toggle();
                }}
                onPointerEnter={(e) => (e.pointerType === "touch" ? undefined : intent.enter())}
                onPointerLeave={intent.leave}
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        close();
                    }
                }}
                // A press on the slot must not move the focus out of the terminal he types in.
                onMouseDown={(e) => e.preventDefault()}
            >
                <ActivityMark glyph={glyph} waits={summary.waiting.length > 0} />
            </button>
            {open && anchor != null ? (
                <ActivityPopover
                    anchor={anchor}
                    summary={summary}
                    focusFirst={byKeyboard && pinned}
                    onGo={(target) => {
                        close();
                        fireAndForget(() => openActivity(target));
                    }}
                    onClose={close}
                    onEnter={intent.enter}
                    onLeave={intent.leave}
                />
            ) : null}
        </>
    );
}
