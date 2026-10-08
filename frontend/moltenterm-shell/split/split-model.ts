// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Split any panel, then choose its content (FR-SHELL-042, DS-SHELL-064): the rules, pure so they are tested without
// the app. split.ts carries them out on the layout.

export type SplitDirection = "right" | "down" | "left" | "up";

// The block meta key of a new panel's picker: the panel it was split from (DS-SHELL-066).
export const SplitFromMetaKey = "molten:splitfrom";

// Wave's layout refuses to resize a panel below 40 px (layoutModel.ts MinNodeSizePx); a split keeps both panels above.
export const MinPanelPx = 40;

export const HalfSplit = 0.5;

// Wave's split actions: horizontal puts the panels side by side, vertical one above the other.
export function splitAxis(direction: SplitDirection): {
    axis: "horizontal" | "vertical";
    position: "before" | "after";
} {
    switch (direction) {
        case "left":
            return { axis: "horizontal", position: "before" };
        case "up":
            return { axis: "vertical", position: "before" };
        case "down":
            return { axis: "vertical", position: "after" };
        default:
            return { axis: "horizontal", position: "after" };
    }
}

// The new panel's share of the source panel, kept so neither panel goes below the layout's minimum. A source too
// small for two panels splits in half (Wave's own minimum then applies).
export function clampFraction(fraction: number, sourcePx: number, minPx = MinPanelPx): number {
    const f = Number.isFinite(fraction) ? fraction : HalfSplit;
    if (!(sourcePx > 2 * minPx)) {
        return HalfSplit;
    }
    const min = minPx / sourcePx;
    return Math.min(Math.max(f, min), 1 - min);
}

// The layout sizes of the source and the new panel: the new one takes its share of the source's own size, so the
// other panels of the row or column keep theirs (Wave's split gives the new panel a default size and shrinks them all).
export function splitSizes(sourceSize: number, fraction: number): { source: number; added: number } {
    const f = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : HalfSplit;
    return { source: sourceSize * (1 - f), added: sourceSize * f };
}

// The new panel's share from where a handle drag was released, in the source panel's own coordinates: the right handle
// leaves the new panel on the right of the line, the bottom handle below it.
export function dragFraction(direction: "right" | "down", pointer: number, start: number, length: number): number {
    if (!(length > 0)) {
        return HalfSplit;
    }
    const at = pointer - start;
    return (length - at) / length;
}

// What Enter on Terminal opens: a shell in the source panel's folder and on its connection, as Wave's Cmd+D did
// (keymodel.ts getDefaultNewBlockDef). A shell without cmd:cwd starts in the workspace folder (FR-SHELL-009, #82).
export function terminalBlockDefFrom(source: MetaType): BlockDef {
    const meta: MetaType = { view: "term", controller: "shell" };
    if (source?.view === "term" && source?.["cmd:cwd"] != null) {
        meta["cmd:cwd"] = source["cmd:cwd"];
    }
    if (source?.connection != null) {
        meta.connection = source.connection;
    }
    return { meta };
}

// The panel kinds the picker offers first, in this order (DS-SHELL-066); the configured widgets keep their own order
// after them.
export const PanelKindOrder = [
    "term",
    "molten-browser",
    "preview",
    "molten-project",
    "molten-cicd",
    "molten-companion",
    "molten-sessions",
    "sysinfo",
    "processviewer",
];

export function panelKindRank(view: string): number {
    const i = PanelKindOrder.indexOf(view);
    return i === -1 ? PanelKindOrder.length : i;
}

// The edge handle shows only where a split would fit and nothing else claims the pointer (DS-SHELL-065).
export function handlesAllowed(opts: {
    preview: boolean;
    ephemeral: boolean;
    magnified: boolean;
    resizing: boolean;
    width: number;
    height: number;
    edge: "right" | "down";
}): boolean {
    if (opts.preview || opts.ephemeral || opts.magnified || opts.resizing) {
        return false;
    }
    const length = opts.edge === "right" ? opts.width : opts.height;
    return length >= 2 * MinPanelPx;
}

// Which edge the pointer is near, inside the panel: hotPx from the right or the bottom edge, past the inset that
// leaves the layout's resize gutter alone. The corner belongs to the nearer edge.
export function nearEdge(
    x: number,
    y: number,
    width: number,
    height: number,
    hotPx: number,
    insetPx: number
): "right" | "down" {
    if (x < 0 || y < 0 || x > width || y > height) {
        return null;
    }
    const fromRight = width - x;
    const fromBottom = height - y;
    const right = fromRight >= insetPx && fromRight <= hotPx + insetPx;
    const bottom = fromBottom >= insetPx && fromBottom <= hotPx + insetPx;
    if (right && bottom) {
        return fromRight <= fromBottom ? "right" : "down";
    }
    if (right) {
        return "right";
    }
    if (bottom) {
        return "down";
    }
    return null;
}
