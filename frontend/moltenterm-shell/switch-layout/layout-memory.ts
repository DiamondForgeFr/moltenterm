// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The remembered layout of a workspace's active view (FR-SHELL-082, #2407): a switch draws the next workspace's panel
// frames before its views are mounted, so the old view fades into the new one's layout instead of cutting to it. It is
// the frames' geometry only, never a picture: each panel's block id, kind and place as shares of the content area,
// plus the content area's insets from the window's edges (the sidebar and the frame's margins keep their pixel sizes
// when the window is resized, the panels share what is left). This module reads and writes this run's copy, in
// localStorage, which every view reads at once; layout-store.ts also keeps it in the workspace's meta, which outlives a
// restart (the pages' session, and its localStorage, are kept in memory only).

export const LayoutKeyPrefix = "moltenterm:switch-layout:";
// A layout this old is still the best guess of where the panels are: it is only dropped with its workspace.
export const LayoutMaxPanels = 32;

export type RememberedPanel = {
    id: string;
    // The block's view (term, web, preview…): the frame is drawn the same for every kind, the kind is kept for later.
    kind: string;
    // Shares of the content area, 0 to 1.
    x: number;
    y: number;
    w: number;
    h: number;
};

export type ContentInsets = { left: number; top: number; right: number; bottom: number };

export type RememberedLayout = {
    workspaceId: string;
    tabId: string;
    insets: ContentInsets;
    panels: RememberedPanel[];
    at: number;
};

export type Box = { left: number; top: number; width: number; height: number };

export type MeasuredBlock = { id: string; kind: string; rect: Box };

export function layoutKey(workspaceId: string): string {
    return LayoutKeyPrefix + workspaceId;
}

function share(v: number): number {
    if (!Number.isFinite(v)) {
        return 0;
    }
    return Math.round(Math.max(0, Math.min(1, v)) * 10000) / 10000;
}

function px(v: number): number {
    return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

// The layout the blocks on screen make inside the content area of a window of this size. Blocks are kept in the order
// given (the page's order), clipped to the content area; a block wholly outside it (a magnified or hidden one) is left out.
export function measureLayout(
    workspaceId: string,
    tabId: string,
    content: Box,
    windowSize: { width: number; height: number },
    blocks: readonly MeasuredBlock[],
    at: number
): RememberedLayout {
    if (!workspaceId || content == null || !(content.width > 0) || !(content.height > 0)) {
        return null;
    }
    const panels: RememberedPanel[] = [];
    const seen = new Set<string>();
    for (const b of blocks) {
        if (b?.id == null || seen.has(b.id) || b.rect == null) {
            continue;
        }
        const left = Math.max(b.rect.left, content.left);
        const top = Math.max(b.rect.top, content.top);
        const right = Math.min(b.rect.left + b.rect.width, content.left + content.width);
        const bottom = Math.min(b.rect.top + b.rect.height, content.top + content.height);
        if (right - left < 1 || bottom - top < 1) {
            continue;
        }
        seen.add(b.id);
        panels.push({
            id: b.id,
            kind: typeof b.kind === "string" ? b.kind : "",
            x: share((left - content.left) / content.width),
            y: share((top - content.top) / content.height),
            w: share((right - left) / content.width),
            h: share((bottom - top) / content.height),
        });
        if (panels.length >= LayoutMaxPanels) {
            break;
        }
    }
    return {
        workspaceId,
        tabId: tabId ?? "",
        insets: {
            left: px(content.left),
            top: px(content.top),
            right: px(windowSize.width - content.left - content.width),
            bottom: px(windowSize.height - content.top - content.height),
        },
        panels,
        at,
    };
}

// Two layouts draw the same frames: a write is skipped when nothing moved.
export function sameLayout(a: RememberedLayout, b: RememberedLayout): boolean {
    if (a == null || b == null) {
        return a === b;
    }
    if (a.workspaceId !== b.workspaceId || a.tabId !== b.tabId || a.panels.length !== b.panels.length) {
        return false;
    }
    const ia = a.insets;
    const ib = b.insets;
    if (ia.left !== ib.left || ia.top !== ib.top || ia.right !== ib.right || ia.bottom !== ib.bottom) {
        return false;
    }
    return a.panels.every((p, i) => {
        const q = b.panels[i];
        return p.id === q.id && p.kind === q.kind && p.x === q.x && p.y === q.y && p.w === q.w && p.h === q.h;
    });
}

function finiteShare(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? share(v) : NaN;
}

export function parseLayout(raw: string): RememberedLayout {
    if (!raw) {
        return null;
    }
    try {
        const v = JSON.parse(raw);
        if (typeof v?.workspaceId !== "string" || !Array.isArray(v?.panels)) {
            return null;
        }
        const panels: RememberedPanel[] = [];
        for (const p of v.panels.slice(0, LayoutMaxPanels)) {
            const x = finiteShare(p?.x);
            const y = finiteShare(p?.y);
            const w = finiteShare(p?.w);
            const h = finiteShare(p?.h);
            if (typeof p?.id !== "string" || [x, y, w, h].some((n) => Number.isNaN(n)) || w <= 0 || h <= 0) {
                continue;
            }
            panels.push({ id: p.id, kind: typeof p.kind === "string" ? p.kind : "", x, y, w, h });
        }
        const i = v.insets ?? {};
        return {
            workspaceId: v.workspaceId,
            tabId: typeof v.tabId === "string" ? v.tabId : "",
            insets: { left: px(i.left), top: px(i.top), right: px(i.right), bottom: px(i.bottom) },
            panels,
            at: Number(v.at) || 0,
        };
    } catch {
        return null;
    }
}

// The content area a layout takes in a window of this size: its insets kept in pixels, the rest for the panels.
export function contentBoxFor(layout: RememberedLayout, windowSize: { width: number; height: number }): Box {
    const i = layout.insets;
    return {
        left: i.left,
        top: i.top,
        width: Math.max(0, windowSize.width - i.left - i.right),
        height: Math.max(0, windowSize.height - i.top - i.bottom),
    };
}

// The panels' frames in a content area of today's size: proportional to the area, never the pixels they had.
export function scaleLayout(layout: RememberedLayout, box: Box): { id: string; kind: string; rect: Box }[] {
    if (layout == null || box == null) {
        return [];
    }
    return layout.panels.map((p) => ({
        id: p.id,
        kind: p.kind,
        rect: {
            left: box.left + p.x * box.width,
            top: box.top + p.y * box.height,
            width: p.w * box.width,
            height: p.h * box.height,
        },
    }));
}

// The area two rectangles share, in px²; 0 when they only touch.
export function overlapArea(a: Box, b: Box): number {
    const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
}

export type LayoutStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): LayoutStorage {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

export function readLayout(workspaceId: string, store: LayoutStorage = storage()): RememberedLayout {
    if (!workspaceId || store == null) {
        return null;
    }
    try {
        const layout = parseLayout(store.getItem(layoutKey(workspaceId)));
        return layout?.workspaceId === workspaceId ? layout : null;
    } catch {
        return null;
    }
}

export function writeLayout(layout: RememberedLayout, store: LayoutStorage = storage()) {
    if (layout == null || store == null) {
        return;
    }
    try {
        store.setItem(layoutKey(layout.workspaceId), JSON.stringify(layout));
    } catch {
        // A full storage keeps the previous layout: the switch then draws a little out of date, or nothing.
    }
}

// The keys of workspaces that no longer exist, to drop.
export function staleLayoutKeys(keys: readonly string[], workspaceIds: readonly string[]): string[] {
    const live = new Set(workspaceIds.map(layoutKey));
    return keys.filter((k) => k.startsWith(LayoutKeyPrefix) && !live.has(k));
}
