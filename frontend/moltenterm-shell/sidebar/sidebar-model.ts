// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace sidebar's rules (FR-SHELL-079, DS-SHELL-123, DS-SHELL-124): its width bounds, the tile grid, which tabs
// are tiles and which are temporary views, the build letter and the ⌘S guard. Kept apart from the components so the
// rules can be tested without the app.

import type { BuildChannel } from "../build/build-identity";
import { visibleTabIds } from "../hidden-tabs";

export const SidebarSettingKey = "shell:workspacesidebar";
// The window's meta: the sidebar's width and whether it is hidden, shared by every tab view of the window.
export const SidebarWidthMetaKey = "molten:sidebarwidth";
export const SidebarHiddenMetaKey = "molten:sidebarhidden";
// The workspace's project type (SaaS, Desktop, CLI…); #1191 lets the user set it.
export const ProjectTypeMetaKey = "molten:projecttype";

export const SidebarMinWidth = 220;
export const SidebarMaxWidth = 420;
export const SidebarDefaultWidth = 264;

export const TileGap = 6;
export const TileMinWidth = 74;
export const TileMaxPerRow = 3;

// The sidebar is on unless the hidden setting turns it off.
export function sidebarEnabled(setting: boolean): boolean {
    return setting !== false;
}

export function clampSidebarWidth(width: number): number {
    if (width == null || !Number.isFinite(width)) {
        return SidebarDefaultWidth;
    }
    return Math.round(Math.min(SidebarMaxWidth, Math.max(SidebarMinWidth, width)));
}

export function readSidebarWidth(meta: Record<string, any>): number {
    const value = meta?.[SidebarWidthMetaKey];
    return typeof value === "number" ? clampSidebarWidth(value) : SidebarDefaultWidth;
}

export function readSidebarHidden(meta: Record<string, any>): boolean {
    return meta?.[SidebarHiddenMetaKey] === true;
}

// The tile grid's columns in CSS, the rule tilesPerRow states: at most 3 a row, never under 74 px, a 6 px gutter.
export const TileGridColumns = `repeat(auto-fill, minmax(max(${TileMinWidth}px, calc((100% - ${TileGap * (TileMaxPerRow - 1)}px) / ${TileMaxPerRow})), 1fr))`;

// How many tiles share a row of the given width: at most 3, never under 74 px each, with a 6 px gutter.
export function tilesPerRow(width: number, maxPerRow = TileMaxPerRow, minWidth = TileMinWidth): number {
    for (let n = maxPerRow; n > 1; n--) {
        if ((width - TileGap * (n - 1)) / n >= minWidth) {
            return n;
        }
    }
    return 1;
}

// Wave removed its own pinned tabs; until #1184 the tiles are the tabs MoltenTerm pins (the Project tab).
export function isPinnedTab(tab: { meta?: Record<string, any> }, pinnedMetaKeys: readonly string[]): boolean {
    return pinnedMetaKeys.some((key) => !!tab?.meta?.[key]);
}

export type SidebarTabSplit = { tiles: string[]; temporary: string[] };

// The workspace's tabs the sidebar shows, in order: the pinned ones as tiles, the others as temporary views. A tab
// whose object is not loaded yet counts as temporary.
export function splitSidebarTabs(
    ws: { tabids?: string[]; meta?: Record<string, any> },
    tabOf: (tabId: string) => { meta?: Record<string, any> },
    pinnedMetaKeys: readonly string[]
): SidebarTabSplit {
    const tiles: string[] = [];
    const temporary: string[] = [];
    for (const id of visibleTabIds(ws)) {
        if (isPinnedTab(tabOf(id), pinnedMetaKeys)) {
            tiles.push(id);
        } else {
            temporary.push(id);
        }
    }
    return { tiles, temporary };
}

export function sameTabSplit(a: SidebarTabSplit, b: SidebarTabSplit): boolean {
    const same = (x: string[], y: string[]) => x.length === y.length && x.every((id, i) => id === y[i]);
    return same(a.tiles, b.tiles) && same(a.temporary, b.temporary);
}

// The new full tab order once the dragged tab lands before (or, at the end, after) the target; hidden tabs keep their
// place in the list.
export function moveTabBefore(tabIds: readonly string[], dragged: string, target: string): string[] {
    if (dragged === target || !tabIds.includes(dragged)) {
        return [...tabIds];
    }
    const rest = tabIds.filter((id) => id !== dragged);
    const at = target == null ? -1 : rest.indexOf(target);
    if (at < 0) {
        return [...rest, dragged];
    }
    return [...rest.slice(0, at), dragged, ...rest.slice(at)];
}

// The row a pointer at clientY drops before: the first row whose middle is below it; null drops after the last.
export function dropTargetAt(clientY: number, rows: { id: string; top: number; height: number }[]): string {
    for (const row of rows) {
        if (clientY < row.top + row.height / 2) {
            return row.id;
        }
    }
    return null;
}

export function readProjectType(ws: { meta?: Record<string, any> }): string {
    const value = ws?.meta?.[ProjectTypeMetaKey];
    return typeof value === "string" ? value.trim() : "";
}

// The build badge's letter key: G for a gold, V for a release; a dev or local build keeps its own.
export function buildLetterKey(channel: BuildChannel): string {
    return `sidebar.build.letter.${channel}`;
}

// ⌘S toggles the sidebar, except where it saves: in a code editor, or in a view that answers it.
export const SaveKeyViews = ["waveconfig", "codeeditor", "builder"];

export function sidebarKeyYields(activeElement: Element, focusedView: string): boolean {
    if (activeElement?.closest?.(".monaco-editor, .cm-editor") != null) {
        return true;
    }
    return SaveKeyViews.includes(focusedView ?? "");
}
