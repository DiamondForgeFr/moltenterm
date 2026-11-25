// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Entering comment mode (FR-BRW-017 AC38 to AC41, #2537): the mode makes itself seen. Two incandescent lights leave the
// middle of the panel's top edge together, run along the frame in opposite directions, down its sides, and meet under the
// comment toolbar, which rises at the same time (annotate-toolbar.tsx rings it and flashes the pencil when they arrive).
// The frame then stays in the action colour while the mode is on. It plays once, when the mode starts, never on a
// tab shown again; under reduced motion there are no lights, only the frame. The look is in annotate-entry.css, on the
// molten motion tokens (suite/suite-language.md, "Panel motion").

import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../molten-motion";
import "./annotate-entry.css";
import { type AnnotateSession, entryPlays } from "./annotate-session";

export type Size = { w: number; h: number };

// The two lights' paths: from the middle of the top edge, one clockwise by the right side, the other counter-clockwise
// by the left, both to the middle of the bottom edge. Inset by the stroke so the glow stays on the frame.
export function entryPaths(size: Size, inset = 1.5): [string, string] {
    const { w, h } = size;
    const mid = w / 2;
    const top = inset;
    const bottom = h - inset;
    const left = inset;
    const right = w - inset;
    return [
        `M ${mid} ${top} L ${right} ${top} L ${right} ${bottom} L ${mid} ${bottom}`,
        `M ${mid} ${top} L ${left} ${top} L ${left} ${bottom} L ${mid} ${bottom}`,
    ];
}

// entryLights: the lights run while the entry plays, never under reduced motion (the frame alone shows then).
export function entryLights(plays: boolean, reduced: boolean): boolean {
    return plays && !reduced;
}

// What the panel draws over itself for the mode: the frame while the mode is on in the shown tab, and the lights while
// its entry plays (never under reduced motion).
export function CommentEntryView({
    on,
    lights,
    size,
    onLightsDone,
}: {
    on: boolean;
    lights: boolean;
    size: Size;
    onLightsDone?: () => void;
}) {
    if (!on) {
        return null;
    }
    const drawn = lights && size.w > 0 && size.h > 0;
    return (
        <>
            <div
                className={lights ? "mt-comment-frame mt-comment-frame-enter" : "mt-comment-frame"}
                data-testid="browser-annotate-frame"
                aria-hidden
            />
            {drawn ? (
                <svg
                    className="mt-comment-lights"
                    width={size.w}
                    height={size.h}
                    viewBox={`0 0 ${size.w} ${size.h}`}
                    data-testid="browser-annotate-lights"
                    aria-hidden
                >
                    {entryPaths(size).map((d, i) => (
                        <path
                            key={i}
                            d={d}
                            pathLength={100}
                            onAnimationEnd={i === 0 ? onLightsDone : undefined}
                        />
                    ))}
                </svg>
            ) : null}
        </>
    );
}

function useSize(ref: React.RefObject<HTMLElement>): Size {
    const [size, setSize] = useState<Size>({ w: 0, h: 0 });
    useLayoutEffect(() => {
        const el = ref.current;
        if (el == null) {
            return;
        }
        const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
    return size;
}

// Mounted over the whole web page panel (its address row and its pages).
export function CommentEntry({ session, activeTabId }: { session: AnnotateSession; activeTabId: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const opens = useAtomValue(session.openAtom);
    const entry = useAtomValue(session.entryAtom);
    const size = useSize(ref);
    const open = opens.find((o) => o.tabId === activeTabId) ?? null;
    const plays = entryPlays(entry, open);
    const reduced = plays && prefersReducedMotion();
    useEffect(() => {
        // Under reduced motion the entry is the frame alone: it is played as soon as it shows.
        if (plays && reduced) {
            session.entryDone(entry.nonce);
        }
    }, [session, plays, reduced, entry]);
    // A start on a tab that is not shown, or a tab left while the lights run: that entry is over, never replayed later.
    useEffect(() => {
        if (entry != null && entry.tabId !== activeTabId) {
            session.entryDone(entry.nonce);
        }
    }, [session, entry, activeTabId]);
    return (
        <div ref={ref} className="mt-comment-entry" aria-hidden>
            <CommentEntryView
                on={open != null}
                lights={entryLights(plays, reduced)}
                size={size}
                onLightsDone={() => entry != null && session.entryDone(entry.nonce)}
            />
        </div>
    );
}
