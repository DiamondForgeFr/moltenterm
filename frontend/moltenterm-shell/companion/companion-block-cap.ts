// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The cap on a block's height (FR-SHELL-018, #2477). A block of the flow grows with its content: with 29 changed files
// the files block became a column that pushed everything else away. Every block now stops at BlockCapPx, header and foot
// included; past it the block's body is clipped, its last BlockFadePx fade into the block, and a bar at its foot says how
// much is hidden ("Show all · 18 more") and unfolds it. A block shorter than the cap is what it was and has no bar. Whether
// a block is unfolded is the developer's, kept per block with the companion's layout (companion-layout.ts); whether it is
// taller than the cap is the content's, measured here. The numbers below are the stylesheet's own (companion-dashboard.css,
// kept equal by companion-block-cap.test.ts).

import { createContext } from "react";
import { setSectionUnfolded } from "./companion-arrange-model";
import type { FlowWatchEnv } from "./companion-flow-watch";
import { CompanionLayout, CompanionSectionId, isUnfolded } from "./companion-layout";

export const BlockCapPx = 500;
export const BlockFadePx = 90;
export const BlockBarPx = 34;

// While a block is measured its clamp is lifted and its bar hidden (companion-dashboard.css), to read the height it has
// without them: the one the cap is compared with.
export const BlockProbeAttr = "data-probe";
export const BlockCappedAttr = "data-capped";

// What the dashboard gives its blocks: whether a block is unfolded, and the way to unfold or fold it (saved with the
// layout, or drafted with it while arranging). Outside the dashboard the value is null and a block has no cap.
export type BlockCapValue = {
    unfolded: (id: string) => boolean;
    toggle: (id: string) => void;
};

export const BlockCapContext = createContext<BlockCapValue>(null);

// The value for a layout: a block reads whether it is unfolded from it, and toggling it hands `save` the layout with that
// block unfolded or folded.
export function makeBlockCapValue(layout: CompanionLayout, save: (layout: CompanionLayout) => void): BlockCapValue {
    return {
        unfolded: (id) => isUnfolded(layout, id as CompanionSectionId),
        toggle: (id) =>
            save(setSectionUnfolded(layout, id as CompanionSectionId, !isUnfolded(layout, id as CompanionSectionId))),
    };
}

// What measuring a block says: whether its content is taller than the cap, and how many of its rows the cap hides.
export type BlockMeasure = { tall: boolean; hidden: number };

export const NoCap: BlockMeasure = { tall: false, hidden: 0 };

export function sameMeasure(a: BlockMeasure, b: BlockMeasure): boolean {
    return a.tall === b.tall && a.hidden === b.hidden;
}

// A block is taller than the cap when its content, with its header and foot, does not fit in it.
export function isTall(natural: number): boolean {
    return natural > BlockCapPx;
}

// The height the flow gives a block: its content's, to the cap while it is folded.
export function blockHeight(natural: number, unfolded: boolean): number {
    return unfolded ? natural : Math.min(natural, BlockCapPx);
}

// How many rows the cap hides: those whose bottom edge lies below the body's. A row the fade cuts counts as hidden, since
// it cannot be read; a pixel of rounding does not.
export function hiddenRowCount(bottoms: readonly number[], visibleBottom: number): number {
    return bottoms.filter((bottom) => bottom > visibleBottom + 1).length;
}

export type CapFoot = {
    labelKey: "companion.block.showAll" | "companion.block.showAllMore" | "companion.block.showLess";
    count?: number;
    chevron: "down" | "up";
};

// The bar's words: "Show all · N more" while the block is folded and hides N rows, a plain "Show all" when it has no rows
// to count (the latest answer, the workspace task), "Show less" with an up chevron once it is unfolded.
export function capFoot(open: boolean, hidden: number): CapFoot {
    if (open) {
        return { labelKey: "companion.block.showLess", chevron: "up" };
    }
    return hidden > 0
        ? { labelKey: "companion.block.showAllMore", count: hidden, chevron: "down" }
        : { labelKey: "companion.block.showAll", chevron: "down" };
}

// What a block of the flow is, given what measuring said and whether the developer unfolded it: folded to the cap, unfolded
// past it, or short enough to be neither.
export function capState(measure: BlockMeasure, unfolded: boolean): { capped: boolean; open: boolean } {
    return { capped: measure.tall && !unfolded, open: measure.tall && unfolded };
}

// Measures a block in the page. Its height is read with the clamp lifted and the bar hidden, so that a folded block says
// how tall it would be; the rows the cap hides are counted in the layout it has, folded. A block that is not folded
// hides none.
export function measureBlock(section: HTMLElement, body: HTMLElement, rows?: string): BlockMeasure {
    section.setAttribute(BlockProbeAttr, "");
    const natural = section.offsetHeight;
    section.removeAttribute(BlockProbeAttr);
    const tall = isTall(natural);
    if (!tall || !rows || !section.hasAttribute(BlockCappedAttr)) {
        return { tall, hidden: 0 };
    }
    const edge = body.getBoundingClientRect().bottom;
    const bottoms = Array.from(body.querySelectorAll<HTMLElement>(rows), (row) => row.getBoundingClientRect().bottom);
    return { tall, hidden: hiddenRowCount(bottoms, edge) };
}

export type BlockWatch = { stop: () => void };

// One block followed in the page: it measures itself now and whenever what it holds changes, and says so only when the
// answer changed. The cap is a maximum, never a size: a block whose content grows past it is capped from then on, and one
// whose content shrinks back under it is exactly its content again, with no bar and no fade.
export type BlockFollow = BlockWatch & { measure: () => void };

export function followBlockCap(
    section: HTMLElement,
    body: HTMLElement,
    rows: string,
    onChange: (measure: BlockMeasure) => void,
    env?: FlowWatchEnv,
    // What the block is drawn as when the following starts, so that the first measure says only what differs.
    initial: BlockMeasure = NoCap
): BlockFollow {
    let last = initial;
    const measure = () => {
        const next = measureBlock(section, body, rows);
        if (sameMeasure(next, last)) {
            return;
        }
        last = next;
        onChange(next);
    };
    const watch = watchBlockCap(section, body, measure, env);
    return { measure, stop: watch.stop };
}

function defaultEnv(): FlowWatchEnv {
    if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") {
        return null;
    }
    return { ResizeObserver, MutationObserver };
}

// What makes a block measure itself again: its own width, which wraps its lines, the size of what its body holds, and the
// rows that come and go in it. The body is clipped once the block is folded, so its own size no longer follows its
// content: the content's own elements are watched instead. Nothing here watches an attribute, so that measuring, which
// lifts and sets one, never starts another measure.
export function watchBlockCap(
    section: HTMLElement,
    body: HTMLElement,
    measure: () => void,
    env: FlowWatchEnv = defaultEnv()
): BlockWatch {
    if (section == null || body == null || env == null) {
        return { stop: () => {} };
    }
    const observed = new Set<Element>();
    const ro = new env.ResizeObserver(() => measure());
    ro.observe(section);
    const sync = () => {
        const now = new Set<Element>(Array.from(body.children));
        observed.forEach((el) => {
            if (!now.has(el)) {
                ro.unobserve(el);
                observed.delete(el);
            }
        });
        now.forEach((el) => {
            if (!observed.has(el)) {
                ro.observe(el);
                observed.add(el);
            }
        });
    };
    const mo = new env.MutationObserver(() => {
        sync();
        measure();
    });
    mo.observe(body, { childList: true, subtree: true, characterData: true });
    sync();
    return {
        stop: () => {
            mo.disconnect();
            ro.disconnect();
            observed.clear();
        },
    };
}
