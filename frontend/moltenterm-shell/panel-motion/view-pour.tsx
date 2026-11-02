// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The view pour (coulée de vue, FR-SHELL-112, #1349): when a view comes on screen through a switch, its content
// slides 8 px from the side of the tiles and fades in, and the tile that was clicked lights up, in
// --mt-duration-base with --mt-ease. Each view is its own renderer (one WebContentsView per tab): a switch to a view
// already open re-initialises it (Wave's reinitVersion), which is the signal; the window's focus coming back is not
// a switch and moves nothing. Only transform and opacity animate, through the Web Animations API, so the switch
// writes no style the layout depends on and reads no layout back. Under reduced motion nothing plays.
// The pour holds the view's one moment (pour-moment.ts): a panel arriving meanwhile waits for it to end.

import { globalPrimaryTabStartup } from "@/app/store/global";
import { atoms } from "@/app/store/global-atoms";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../molten-motion";
import "./panel-motion.css";
import { markPour, notifyViewPour } from "./pour-moment";

export const PourShiftPx = 8;
export const PourAnimationId = "mt-view-pour";
// must match --mt-ease in tokens.css, for a document without the tokens (a test)
export const PourEaseFallback = "cubic-bezier(0.2, 0, 0, 1)";

// "x": the tiles are in the sidebar, on the left; "y": in a tab strip above the content.
export type PourAxis = "x" | "y";

// A CSS time ("180ms", "0.18s", "0ms") in ms; NaN when it is not one.
export function parseCssTime(value: string): number {
    const m = /^(-?[\d.]+)(ms|s)$/.exec((value ?? "").trim());
    if (m == null) {
        return NaN;
    }
    const n = parseFloat(m[1]);
    return m[2] === "s" ? n * 1000 : n;
}

export function pourKeyframes(axis: PourAxis): Keyframe[] {
    const from = axis === "y" ? `translateY(-${PourShiftPx}px)` : `translateX(-${PourShiftPx}px)`;
    return [
        { opacity: 0, transform: from },
        { opacity: 1, transform: "none" },
    ];
}

// Plays the pour on el (the panels' container); returns the animation, or null when nothing moves (reduced motion, a
// 0 duration, no Web Animations). A pour still running is replaced by the new one.
export function playPour(el: HTMLElement, axis: PourAxis): Animation {
    if (el == null || typeof el.animate !== "function" || prefersReducedMotion(el.ownerDocument)) {
        return null;
    }
    // Reading custom properties recalculates style at most, never layout.
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    const ms = parseCssTime(style?.getPropertyValue("--mt-duration-base"));
    if (!(ms > 0)) {
        return null;
    }
    const easing = style?.getPropertyValue("--mt-ease")?.trim() || PourEaseFallback;
    for (const running of el.getAnimations?.() ?? []) {
        if (running.id === PourAnimationId) {
            running.cancel();
        }
    }
    const anim = el.animate(pourKeyframes(axis), { duration: ms, easing, id: PourAnimationId });
    markPour(ms);
    return anim;
}

// The pour on the panels' container, at each switch to this view: the first show of a view opened after the app's
// start (a new view, or one not loaded yet), then each switch back to it. The view the app starts on does not pour.
export function useViewPour(ref: React.RefObject<HTMLElement>, axis: PourAxis) {
    const reinit = useAtomValue(atoms.reinitVersion);
    useEffect(() => {
        if (!reinit && globalPrimaryTabStartup) {
            return;
        }
        playPour(ref.current, axis);
        notifyViewPour();
    }, [reinit]);
}

// The tile's light at a switch: shown on the active tile for one pour, then gone. Not under reduced motion, where the
// tile simply shows as the active one.
export function PourLight({ active }: { active: boolean }) {
    const reinit = useAtomValue(atoms.reinitVersion);
    const [lit, setLit] = useState(0);
    // A view opened after the app's start lights its tile at its first show too, as useViewPour pours it.
    const seen = useRef(globalPrimaryTabStartup ? reinit : -1);
    useEffect(() => {
        if (seen.current === reinit) {
            return;
        }
        seen.current = reinit;
        if (!active || prefersReducedMotion()) {
            return;
        }
        setLit(reinit + 1);
    }, [reinit, active]);
    if (!lit || !active) {
        return null;
    }
    return (
        <span
            key={lit}
            className="mt-pour-lit"
            data-testid="sidebar-pour-lit"
            aria-hidden
            onAnimationEnd={(e) => {
                if (e.target === e.currentTarget) {
                    setLit(0);
                }
            }}
        />
    );
}
