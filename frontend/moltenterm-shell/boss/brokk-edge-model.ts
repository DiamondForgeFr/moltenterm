// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk at the collapsed sidebar's edge (FR-BOSS-009, AC27 to AC30, AC44 to AC47, #2070, #2093): the collapsed sidebar
// is out of sight at rest, peeks out with his face and bounces for a new notification before hiding again, and stays
// half open while he wants to talk. Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

// How much of the collapsed sidebar shows while it peeks out for news, and while it is half open. sidebar.css holds the
// same numbers (--mt-edge-px, --mt-ajar-px): a test keeps the two equal.
// 30 px, not 22: the concentric download ring (#2083) reaches 14.8 px from the face's centre, and the face is centred.
export const EdgePx = 30;
export const AjarPx = 190;
// The face in the strip, smaller than the 26 px of the title row so that it fits, with the badge and the ring around it.
export const EdgeFacePx = 20;

// The app's one easing (--mt-ease), which a Web Animation cannot read from a variable.
const MtEase = "cubic-bezier(0.2, 0, 0, 1)";

// The sidebar's own slide (--mt-duration-base in tokens.css): the bounce starts once the sidebar is out.
export const EdgeSlideMs = 180;
// Two small bounces: out by 22 px and back, out by 12 px and back.
export const BounceMs = 900;
export const BounceOutPx = [22, 12];
// Under reduced motion (--mt-duration-fade): the peek fades in, stays, and fades out.
export const EdgeFadeMs = 120;
export const PeekStillMs = 1000;

// Where the sidebar stands, as Brokk sees it: on screen (docked, or unfolded over the content), collapsed at the window's
// edge, where his face shows when it peeks out, or nowhere (the sidebar is turned off and the tab bar is back, or Brokk is).
export type SidebarPlace = "screen" | "edge" | "none";

export function sidebarPlaceOf(enabled: boolean, hidden: boolean, peek: boolean, brokkShown: boolean): SidebarPlace {
    if (!enabled) {
        return "none";
    }
    if (!hidden || peek) {
        return "screen";
    }
    return brokkShown ? "edge" : "none";
}

// The sentence of the event shows on the scene of a collapsed sidebar, half open for him or unfolded (AC29, AC47).
export function edgeLineOn(hidden: boolean, brokkShown: boolean): boolean {
    return hidden && brokkShown;
}

// The collapsed sidebar is out of sight at rest (AC44), peeks out by its strip while it tells a new notification (AC45),
// and stays half open while a visit is due or held back (AC46).
export type EdgeShape = "rest" | "peek" | "ajar";

export function edgeShapeOf(place: SidebarPlace, view: { visit: boolean; cue: boolean; telling?: boolean }): EdgeShape {
    if (place !== "edge") {
        return null;
    }
    if (view.visit || view.cue) {
        return "ajar";
    }
    return view.telling ? "peek" : "rest";
}

// How far the face is moved from its place in the title row to stand in the strip: its right edge is the row's, 12 px
// inside the sidebar's, and it must end up centred in the strip.
export function edgeFaceShiftPx(peekInsetPx: number): number {
    return peekInsetPx - (EdgePx - EdgeFacePx) / 2;
}

export type EdgeNews = {
    // What the developer has looked at, and what the sidebar already told by moving: both are keys of the badge.
    seen: ReadonlySet<string>;
    told: ReadonlySet<string>;
    // The feeds had been read at the last step: the first reading is the baseline, whatever it held.
    ready: boolean;
};

export const NoNews: EdgeNews = { seen: new Set(), told: new Set(), ready: false };

export type EdgeNewsStep = {
    news: EdgeNews;
    // A key the sidebar has not told appeared: it bounces, once.
    fresh: boolean;
    // A key the developer has not looked at stands on the badge: with reduced motion, the face shows it.
    unseen: boolean;
};

function keptIn(keys: ReadonlySet<string>, now: ReadonlySet<string>): Set<string> {
    return new Set([...keys].filter((key) => now.has(key)));
}

// `keys` are what the badge counts now. Looking (the sidebar is on screen, or his group is open) sees everything, and so
// does the first reading of the feeds (`ready`): what was there when the window opened is no news. A key that leaves is
// forgotten, so that the same one coming back is news again.
export function edgeNewsAfter(before: EdgeNews, keys: string[], looking: boolean, ready: boolean): EdgeNewsStep {
    const now = new Set(keys);
    if (looking || !ready || !before.ready) {
        return { news: { seen: now, told: now, ready }, fresh: false, unseen: false };
    }
    const seen = keptIn(before.seen, now);
    const told = keptIn(before.told, now);
    const fresh = keys.some((key) => !told.has(key));
    const unseen = keys.some((key) => !seen.has(key));
    return { news: { seen, told: new Set([...told, ...keys]), ready }, fresh, unseen };
}

// A new bounce was told since the last one: the sidebar tells it if it still waits at the edge. One that was unfolded
// meanwhile has been looked at, and what it had to tell is told.
export function newsToTell(count: number, played: number, place: SidebarPlace): { played: number; tell: boolean } {
    if (count === played) {
        return { played, tell: false };
    }
    return { played: count, tell: place === "edge" };
}

// What the sidebar plays as its shape changes: the bounce as it comes out for news or for a visit (AC45, AC46); under
// reduced motion a fade in and out of the peek, or a fade in of the half-open state. Folding back to the half-open
// state after a hover, or from the screen, plays nothing (AC47): only a sidebar that was out of sight, or peeking, is news.
export type EdgeMotion = "bounce" | "peek-fade" | "fade-in";

export function edgeMotionOf(before: EdgeShape, after: EdgeShape, tellStarts: boolean, reduced: boolean): EdgeMotion {
    if (after === "ajar" && (before === "rest" || before === "peek")) {
        return reduced ? "fade-in" : "bounce";
    }
    if (!tellStarts || (after !== "peek" && after !== "ajar")) {
        return null;
    }
    if (!reduced) {
        return "bounce";
    }
    return after === "peek" ? "peek-fade" : null;
}

// The movement of a bounce, to lay over the sidebar's own transform: out and back, twice.
export function bounceKeyframes(): { transform: string; offset: number }[] {
    const [first, second] = BounceOutPx;
    return [
        { transform: "translateX(0px)", offset: 0 },
        { transform: `translateX(${first}px)`, offset: 0.18 },
        { transform: "translateX(0px)", offset: 0.36 },
        { transform: `translateX(${second}px)`, offset: 0.54 },
        { transform: "translateX(0px)", offset: 0.72 },
        { transform: "translateX(0px)", offset: 1 },
    ];
}

type Keyframes = Record<string, string | number>[];

// The keyframes and timing of each motion. The bounce waits for the slide that brings the sidebar out; the peek's fade
// holds its last frame (transparent) until the sidebar is out of sight again, so it never flashes back.
export function edgeMotionFrames(motion: EdgeMotion): { keyframes: Keyframes; options: Record<string, unknown> } {
    if (motion === "bounce") {
        return {
            keyframes: bounceKeyframes(),
            options: { duration: BounceMs, delay: EdgeSlideMs, easing: MtEase, composite: "add" },
        };
    }
    if (motion === "peek-fade") {
        const total = PeekStillMs + 2 * EdgeFadeMs;
        const fade = EdgeFadeMs / total;
        return {
            keyframes: [
                { opacity: 0, offset: 0 },
                { opacity: 1, offset: fade },
                { opacity: 1, offset: 1 - fade },
                { opacity: 0, offset: 1 },
            ],
            options: { duration: total, easing: "linear", fill: "forwards" },
        };
    }
    return {
        keyframes: [
            { opacity: 0, offset: 0 },
            { opacity: 1, offset: 1 },
        ],
        options: { duration: EdgeFadeMs, easing: "linear" },
    };
}

export type Played = { cancel: () => void; onfinish?: unknown };
type Animated = { animate?: (keyframes: unknown, options: unknown) => Played };

// Plays the motion on the sidebar and hands it back, to be cancelled if the sidebar unfolds meanwhile; `done` runs when
// it ends by itself. Where the page cannot animate, `done` runs at once.
export function playEdgeMotion(element: Animated, motion: EdgeMotion, done: () => void = () => {}): Played {
    if (motion == null) {
        return null;
    }
    if (element?.animate == null) {
        done();
        return null;
    }
    const frames = edgeMotionFrames(motion);
    const played = element.animate(frames.keyframes, frames.options);
    played.onfinish = () => done();
    return played;
}

// What the sidebar's element says of the edge: out of sight, peeking or half open.
export function edgeAttributes(shape: EdgeShape) {
    return { "data-edge": shape ?? undefined };
}

// The pointer over the visible edge unfolds the sidebar, except over the face: it stays under the pointer for the click
// that opens his group, and shows its tooltip (AC30).
export function edgeUnfoldsOn(place: SidebarPlace, overFace: boolean): boolean {
    return place === "edge" && !overFace;
}
