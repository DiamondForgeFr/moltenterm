// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk at the collapsed sidebar's edge (FR-BOSS-009, AC27 to AC30, #2070): where his face stands when the sidebar is not
// on screen, when the sidebar is half open for something important, and when a new notification makes it bounce. Pure, so
// the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

// What the collapsed sidebar leaves of itself at the window's left edge, and how much of it shows while it is half
// open. sidebar.css holds the same numbers (--mt-edge-px, --mt-ajar-px): a test keeps the two equal.
// 30 px, not 22: the concentric download ring (#2083) reaches 14.8 px from the face's centre, and the face is centred.
export const EdgePx = 30;
export const AjarPx = 190;
// The face in the strip, smaller than the 26 px of the title row so that it fits, with the badge and the ring around it.
export const EdgeFacePx = 20;

// The app's one easing (--mt-ease), which a Web Animation cannot read from a variable.
const MtEase = "cubic-bezier(0.2, 0, 0, 1)";

// Two small bounces: out by 22 px and back, out by 12 px and back.
export const BounceMs = 900;
export const BounceOutPx = [22, 12];

// Where the sidebar stands, as Brokk sees it: on screen (docked, or unfolded over the content), collapsed at the window's
// edge with his face on it, or nowhere (the sidebar is turned off and the tab bar is back, or Brokk is).
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

// The content leaves the strip its room for as long as the sidebar is collapsed with Brokk on, unfolded over it or not:
// the panels must not move (and their terminals not resize) each time the pointer brings the sidebar out.
export function edgeGutterOn(hidden: boolean, brokkShown: boolean): boolean {
    return hidden && brokkShown;
}

// The collapsed sidebar at rest shows its strip; it stays half open while a visit is due or held back.
export type EdgeShape = "rest" | "ajar";

export function edgeShapeOf(place: SidebarPlace, view: { visit: boolean; cue: boolean }): EdgeShape {
    if (place !== "edge") {
        return null;
    }
    return view.visit || view.cue ? "ajar" : "rest";
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

export type Bounce = { cancel: () => void };
type Bouncer = { animate?: (keyframes: unknown, options: unknown) => Bounce };

// Plays the bounce on the sidebar and hands it back, to be cancelled if the sidebar unfolds meanwhile. Reduced motion
// plays nothing: the badge and the face's outline say it.
export function playBounce(element: Bouncer, reducedMotion: boolean): Bounce {
    if (reducedMotion || element?.animate == null) {
        return null;
    }
    return element.animate(bounceKeyframes(), { duration: BounceMs, easing: MtEase, composite: "add" });
}

type Edge = Bouncer & { dataset?: { edge?: string } };

// A new bounce was told since the last one played: the sidebar plays it if it still waits at the edge. One that was
// unfolded meanwhile has been looked at, and what it had to tell is told.
export function bounceOnNews(
    count: number,
    played: number,
    element: Edge,
    reducedMotion: boolean
): { played: number; bounce: Bounce } {
    if (count === played) {
        return { played, bounce: null };
    }
    return { played: count, bounce: element?.dataset?.edge != null ? playBounce(element, reducedMotion) : null };
}

// What the sidebar's element says of the edge: how open it stays, and whether the content leaves the strip its room.
export function edgeAttributes(shape: EdgeShape, hidden: boolean, brokkShown: boolean) {
    return {
        "data-edge": shape ?? undefined,
        "data-gutter": edgeGutterOn(hidden, brokkShown) ? "true" : undefined,
    };
}

// The pointer over the visible edge unfolds the sidebar, except over the face: it stays under the pointer for the click
// that opens his group, and shows its tooltip (AC30).
export function edgeUnfoldsOn(place: SidebarPlace, overFace: boolean): boolean {
    return place === "edge" && !overFace;
}
