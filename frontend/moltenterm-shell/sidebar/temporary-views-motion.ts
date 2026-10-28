// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The temporary views' motion (FR-SHELL-080, #1253), as in Arc: a new row slides in while the rows below make room, a
// closed row's neighbours close the gap, Clear folds the rows away downward, staggered. Only transform and opacity
// move (temporary-views.css): the rows' places are read once per frame, all reads before any write, so a change
// costs at most one layout a frame, and its animation none. Reduced motion: every change is immediate.

import { useLayoutEffect, useRef } from "react";
import { prefersReducedMotion } from "../molten-motion";
import { foldDelayMs } from "./temporary-clear";
import "./temporary-views.css";

export const RowSelector = "[data-testid='sidebar-view-row']";
export const MotionAttr = "data-tv-motion";
// must match --mt-ease in tokens.css: a row's move is a Web Animation, which cannot read the token
const MtEase = "cubic-bezier(0.2, 0, 0, 1)";
const MoveMs = 200;

function rowsOf(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(RowSelector));
}

// An entering row drops its mark once in place, so a later render never plays it again.
function clearEnterOnEnd(el: HTMLElement) {
    const done = (e: Event) => {
        if (e.target !== el) {
            return;
        }
        el.removeEventListener("animationend", done);
        if (el.getAttribute(MotionAttr) === "in") {
            el.removeAttribute(MotionAttr);
        }
    };
    el.addEventListener("animationend", done);
}

// The rows' moves between two lists: the offset each staying row travels from, and the rows that enter.
export function planRowMotion(
    before: ReadonlyMap<string, number>,
    after: ReadonlyMap<string, number>
): { moves: Map<string, number>; entering: string[] } {
    const moves = new Map<string, number>();
    const entering: string[] = [];
    for (const [id, top] of after) {
        const was = before.get(id);
        if (was == null) {
            entering.push(id);
            continue;
        }
        if (Math.abs(was - top) >= 0.5) {
            moves.set(id, was - top);
        }
    }
    return { moves, entering };
}

// Reads every row's place (offsetTop: the layout's, whatever transform a running move adds), then plays the moves.
function measureAndMove(root: HTMLElement, tops: React.RefObject<Map<string, number>>) {
    if (root == null) {
        return;
    }
    const rows = rowsOf(root);
    const next = new Map(rows.map((el) => [el.dataset.tabId, el.offsetTop]));
    const before = tops.current;
    tops.current = next;
    if (before == null || prefersReducedMotion(root.ownerDocument)) {
        return;
    }
    const { moves, entering } = planRowMotion(before, next);
    const byId = new Map(rows.map((el) => [el.dataset.tabId, el]));
    for (const id of entering) {
        const el = byId.get(id);
        el.setAttribute(MotionAttr, "in");
        clearEnterOnEnd(el);
    }
    for (const [id, dy] of moves) {
        const el = byId.get(id);
        if (typeof el.animate !== "function") {
            continue;
        }
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
            duration: MoveMs,
            easing: MtEase,
        });
    }
}

export function useTemporaryViewsMotion(listRef: React.RefObject<HTMLElement>, ids: string[], clearing: Set<string>) {
    const tops = useRef<Map<string, number>>(null);
    const frame = useRef<number>(null);
    const signature = ids.join("\u0001");
    // Several changes landing in one frame (Clear's closes) are measured once, in that frame's animation callback:
    // the frame then lays out once, and the inverted places are set before it paints.
    useLayoutEffect(() => {
        if (frame.current != null) {
            return;
        }
        frame.current = requestAnimationFrame(() => {
            frame.current = null;
            measureAndMove(listRef.current, tops);
        });
    }, [signature]);
    useLayoutEffect(() => () => cancelAnimationFrame(frame.current), []);
    const clearingKey = [...clearing].join("\u0001");
    useLayoutEffect(() => {
        const root = listRef.current;
        if (root == null) {
            return;
        }
        const rows = rowsOf(root);
        const folding = rows.filter((el) => clearing.has(el.dataset.tabId));
        folding.forEach((el, i) => {
            el.style.setProperty("--tv-delay", `${foldDelayMs(i, folding.length)}ms`);
            el.setAttribute(MotionAttr, "out");
        });
        for (const el of rows) {
            if (!clearing.has(el.dataset.tabId) && el.getAttribute(MotionAttr) === "out") {
                el.removeAttribute(MotionAttr);
                el.style.removeProperty("--tv-delay");
            }
        }
    }, [clearingKey, signature]);
}
