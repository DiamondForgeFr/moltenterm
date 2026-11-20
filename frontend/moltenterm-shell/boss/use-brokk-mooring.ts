// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's open group slides with the sidebar it is moored to (FR-BOSS-009, AC107, AC108, #2421). The group's root and the
// thread take their new place at once, then play back from where they were seen, in the sidebar's own time and curve: a
// transform on the compositor, nothing laid out again during the motion. The rules are brokk-mooring-model.ts's.

import { useLayoutEffect, useRef } from "react";
import { groupSlideFrames, matrixXOf, playSlide, Slide, SlidePlayed, threadSlideFrames } from "./brokk-mooring-model";

export const ThreadSelector = "[data-testid='brokk-thread']";

export type MooringFrame = {
    place: { left: number };
    thread: { x: number; w: number };
    slide?: Slide;
    layerX?: number;
};

type Line = { x: number; w: number };
export type Moored = { left: number; thread: Line };
export type Played = { group: SlidePlayed; thread: SlidePlayed };
export type SlideTarget = { animate?: (keyframes: unknown, options: unknown) => SlidePlayed };

// One step of the follow: `before` is where the group and the thread stood on screen, `next` where they stand now. `transformOf`
// reads an element's computed transform, a slide still under way included. Hands back what now plays.
export function followSlide(
    targets: { root: SlideTarget; thread: SlideTarget },
    before: Moored,
    next: Moored,
    slide: Slide,
    shown: boolean,
    playing: Played,
    transformOf: (target: SlideTarget) => string
): Played {
    // Only an open group follows a slide: one on its way in or out arrives from, or goes back to, the face.
    if (targets.root == null || before == null || slide == null || !shown) {
        return playing;
    }
    const seenLeft = before.left + matrixXOf(transformOf(targets.root)).tx;
    let seenLine: Line = null;
    if (before.thread != null && targets.thread != null) {
        const m = matrixXOf(transformOf(targets.thread));
        seenLine = { x: before.thread.x + m.tx, w: before.thread.w * m.scale };
    }
    playing?.group?.cancel();
    playing?.thread?.cancel();
    return {
        group: playSlide(targets.root, groupSlideFrames(seenLeft, next.left), slide),
        thread: playSlide(targets.thread, threadSlideFrames(seenLine, next.thread), slide),
    };
}

function computedTransform(target: SlideTarget): string {
    return target instanceof Element ? getComputedStyle(target).transform : "";
}

export function useMooringSlide(rootRef: React.RefObject<HTMLElement>, frame: MooringFrame, shown: boolean) {
    const seen = useRef<Moored>(null);
    const played = useRef<Played>({ group: null, thread: null });
    const slideRef = useRef<Slide>(frame.slide);
    slideRef.current = frame.slide;
    const shownRef = useRef(shown);
    shownRef.current = shown;
    // On screen: the layer moves itself when the sidebar docks or undocks, and the group's place in it may not change.
    const layerX = frame.layerX ?? 0;
    const left = frame.place.left + layerX;
    const threadX = frame.thread == null ? null : frame.thread.x + layerX;
    const threadW = frame.thread?.w;

    useLayoutEffect(() => {
        const root = rootRef.current;
        const before = seen.current;
        const next: Moored = { left, thread: threadX == null ? null : { x: threadX, w: threadW } };
        seen.current = next;
        const thread = root?.parentElement?.querySelector<HTMLElement>(ThreadSelector) ?? null;
        played.current = followSlide(
            { root, thread },
            before,
            next,
            slideRef.current,
            shownRef.current,
            played.current,
            computedTransform
        );
    }, [rootRef, left, threadX, threadW]);
}
