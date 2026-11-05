// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The workspace dots' ripple (FR-SHELL-082, #1943): while an agent of a workspace works, two thin circles in the
// workspace's colour leave its dot one after the other and fade out (sidebar.css, .is-working). The motion is CSS only;
// this file decides when a dot ripples and keeps the ripple on the frames the dominoes and the sidebar's heat draw.
// Kept apart from the components so the rules can be tested without the app.

import { SidebarHeatStepsPerSecond } from "./sidebar-heat";

export const RippleAnimationName = "mt-sb-ripple";

export type DotLook = {
    // The fixed ring: unread items, or an agent waiting for the developer. It is shown on the other workspaces only,
    // since the current one is already where the developer is.
    ring: boolean;
    // The ripple. The ring wins over it, being the more urgent.
    ripple: boolean;
};

export function workspaceDotLook(opts: {
    active: boolean;
    unread: number;
    waiting: boolean;
    working: number;
}): DotLook {
    const ring = !opts.active && (opts.unread > 0 || opts.waiting);
    return { ring, ripple: !ring && opts.working > 0 };
}

export type RippleAnimation = {
    animationName?: string;
    startTime: CSSNumberish | null;
};

// A ripple's steps fall on the shared 1/15 s grid only if its start does: a CSS animation starts on whichever frame
// first styled it, and its steps would then land between the dominoes' and the heat's, doubling the frames drawn while
// both run (#473, #1399). The start goes back onto the nearest earlier grid line, under 1/15 s: a ripple changes by a
// thirty-sixth of its cycle there, which no one sees, and nothing flashes since it only ever moves earlier.
export function snapRipple(anim: RippleAnimation) {
    if (anim.animationName !== RippleAnimationName || anim.startTime == null) {
        return;
    }
    const start = Number(anim.startTime);
    const step = 1000 / SidebarHeatStepsPerSecond;
    // A start already on a line must not drop a whole step on a rounding error.
    const snapped = Math.floor(start / step + 1e-6) * step;
    if (Math.abs(snapped - start) < 0.01) {
        return;
    }
    anim.startTime = snapped;
}

// One listener on the row of dots serves every dot: an animationstart bubbles up from the dot that began to ripple,
// and the animations of its pseudo-elements are found from it. The dots' popovers animate too, so the name is checked.
export function snapRipplesOf(event: { animationName: string; target: EventTarget }) {
    if (event.animationName !== RippleAnimationName) {
        return;
    }
    const target = event.target as Element;
    for (const anim of target.getAnimations?.({ subtree: true }) ?? []) {
        snapRipple(anim as unknown as RippleAnimation);
    }
}
