// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's flow (FR-SHELL-018, #2441): its blocks in columns by the companion's width, each into the shortest
// column in the arranged order, a full-width block under the tallest column across them all, and the milestone with the
// agents at work side by side as a pair. A block keeps its column while the column count stays; only a block that
// appears is placed anew. A block that grows pushes the blocks under it in its column and nothing else. The arranging
// mode lays the same blocks out in the same way (#2467). Pure, so it is tested without a window.

// One visible gutter everywhere: the companion's edges, between columns, and from a block's bottom to the top of the
// next block's label, which stands half a notch (18 px) above its border.
export const FlowGutterPx = 24;
export const FlowNotchRisePx = 18;
export const FlowGapYPx = FlowGutterPx + FlowNotchRisePx;
export const TwoColumnsFromPx = 640;
export const ThreeColumnsFromPx = 956;
export const MaxFlowColumns = 3;

// Beyond this many lines between the milestone and the agents, a line shows only while one of its rows is pointed at.
export const LinesOnHoverBeyond = 6;
// The lists of the dashboard (the sub-agents, the tickets in progress here) show this many rows, then "and N more".
export const ListCap = 8;

// What the flow's element dispatches once it moved its blocks, for what follows them (the lines).
export const FlowPlacedEvent = "mt-cdash-placed";

// The milestone and the agents at work, the pair that stands side by side.
export const PairIds: readonly [string, string] = ["tasks", "agents"];

export type FlowBlock = { id: string; height: number; full?: boolean };

export type FlowPlacement = { id: string; column: number; full: boolean; x: number; y: number; width: number };

// The columns chosen for a structure, kept while it stays the same.
export type FlowAssign = { key: string; columns: Record<string, number> };

export type FlowResult = {
    columns: number;
    columnWidth: number;
    innerWidth: number;
    items: FlowPlacement[];
    height: number;
    assign: FlowAssign;
    // The pair stands side by side (from two columns, neither of the two at full width).
    paired: boolean;
};

// The columns for a companion this wide (its whole width, gutters included).
export function columnsFor(companionWidth: number): number {
    if (companionWidth >= ThreeColumnsFromPx) {
        return 3;
    }
    return companionWidth >= TwoColumnsFromPx ? 2 : 1;
}

export function flowKey(blocks: FlowBlock[], columns: number): string {
    return `${columns}|${blocks.map((b) => b.id + (b.full ? "*" : "")).join(",")}`;
}

function sameFrame(key: string, columns: number): boolean {
    return (key ?? "").split("|")[0] === String(columns);
}

// Whether the columns a flow chose hold for the blocks it lays out now (#2467): they do while the blocks that stay keep
// their order and their width setting, whatever came or went around them, as the permission request does with each
// approval. A block moved, or set full width or fluid, chooses the columns again, by rank.
export function keepsColumns(
    previous: readonly Pick<FlowBlock, "id" | "full">[],
    next: readonly Pick<FlowBlock, "id" | "full">[]
): boolean {
    const was = new Map(previous.map((b) => [b.id, b.full === true]));
    const stayed = next.filter((b) => was.has(b.id));
    if (stayed.some((b) => was.get(b.id) !== (b.full === true))) {
        return false;
    }
    const now = new Set(next.map((b) => b.id));
    const before = previous.filter((b) => now.has(b.id));
    return stayed.length === before.length && stayed.every((b, i) => b.id === before[i].id);
}

// The ghost the arranging mode draws for the milestone or the agents at work (#2467) is no part of their pair: it stands in
// the flow like any other block, so that the block that shows keeps the place it has in the normal view instead of being
// drawn up beside a ghost. The flow lays it out under this id.
export function layoutIdOf(id: string, ghost: boolean): string {
    return ghost && (PairIds as readonly string[]).includes(id) ? `ghost:${id}` : id;
}

// Where each block goes, x and y from the flow's top left corner (inside the companion's gutter). previous is the
// assignment the last call returned: its columns hold while the column count is the same.
export function flowLayout(blocks: FlowBlock[], companionWidth: number, previous?: FlowAssign): FlowResult {
    const n = columnsFor(companionWidth);
    const innerWidth = Math.max(0, companionWidth - 2 * FlowGutterPx);
    const columnWidth = Math.max(0, (innerWidth - FlowGutterPx * (n - 1)) / n);
    const key = flowKey(blocks, n);
    // While the column count stays, each block keeps its column: a block that appears or goes (the permission request
    // with each approval) places only itself, so the others never swap back and forth.
    const sticky = previous != null && sameFrame(previous.key, n) ? previous.columns : {};
    const columns: Record<string, number> = {};
    const tops = new Array<number>(n).fill(0);
    const byId = new Map(blocks.map((b) => [b.id, b]));
    const [left, right] = PairIds;
    const paired = n >= 2 && byId.has(left) && byId.has(right) && !byId.get(left).full && !byId.get(right).full;
    const placed = new Map<string, FlowPlacement>();
    const put = (b: FlowBlock, column: number, y: number, full: boolean) => {
        columns[b.id] = column;
        placed.set(b.id, {
            id: b.id,
            column,
            full,
            x: full ? 0 : column * (columnWidth + FlowGutterPx),
            y,
            width: full ? innerWidth : columnWidth,
        });
    };
    const shortest = () => {
        let c = 0;
        for (let k = 1; k < n; k++) {
            if (tops[k] < tops[c] - 0.5) {
                c = k;
            }
        }
        return c;
    };
    for (const b of blocks) {
        if (placed.has(b.id)) {
            continue;
        }
        const height = Math.max(0, b.height);
        if (n >= 2 && b.full) {
            const y = Math.max(...tops);
            put(b, 0, y, true);
            tops.fill(y + height + FlowGapYPx);
            continue;
        }
        if (paired && (b.id === left || b.id === right)) {
            const lb = byId.get(left);
            const rb = byId.get(right);
            let k = sticky[left];
            if (k == null || k + 1 >= n) {
                k = 0;
                for (let j = 1; j < n - 1; j++) {
                    if (Math.max(tops[j], tops[j + 1]) < Math.max(tops[k], tops[k + 1]) - 0.5) {
                        k = j;
                    }
                }
            }
            const y = Math.max(tops[k], tops[k + 1]);
            put(lb, k, y, false);
            put(rb, k + 1, y, false);
            tops[k] = y + Math.max(0, lb.height) + FlowGapYPx;
            tops[k + 1] = y + Math.max(0, rb.height) + FlowGapYPx;
            continue;
        }
        let c = sticky[b.id];
        if (c == null || c >= n) {
            c = shortest();
        }
        put(b, c, tops[c], false);
        tops[c] += height + FlowGapYPx;
    }
    const height = blocks.length === 0 ? 0 : Math.max(0, Math.max(...tops) - FlowGapYPx);
    return {
        columns: n,
        columnWidth,
        innerWidth,
        items: blocks.map((b) => placed.get(b.id)),
        height,
        assign: { key, columns },
        paired,
    };
}

// Whether the lines between the pair show only while one of their rows is pointed at.
export function linesOnHover(count: number): boolean {
    return count > LinesOnHoverBeyond;
}

// A list as the dashboard shows it: the first ListCap rows, the rest under "and N more" until it is opened.
export function capList<T>(list: readonly T[], open: boolean, cap: number = ListCap): { shown: T[]; more: number } {
    const all = [...(list ?? [])];
    if (open || all.length <= cap) {
        return { shown: all, more: 0 };
    }
    return { shown: all.slice(0, cap), more: all.length - cap };
}
