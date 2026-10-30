// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The carpet's tab strip (FR-SHELL-125, DS-SHELL-135), the radar scrubber turned into tabs: its rules kept apart from
// the component so they are tested without the app. The tabs are the radar's ticks (radar-model.ts) with a name, a
// fallback step by count and width (titles, then icons, then the ticks), the order a drag or Move left / right gives
// the carpet, and the tab menu.

import { LayoutTreeActionType, type LayoutNode, type LayoutTreeMoveNodeAction } from "@/layout/lib/types";
import { t } from "../i18n/i18n";
import { RadarText, type RadarKind, type RadarTick } from "./radar-model";

// Widths of the strip's pieces (radar.css draws them at these sizes). A tab with its title never grows past
// TabMaxPx and never shrinks under TabMinTitlePx; below that it keeps only its icon.
export const TabMaxPx = 190;
export const TabMinTitlePx = 84;
export const TabIconPx = 28;
export const TabGapPx = 4;
// The visible area's frame around its tabs: its padding and border on each side.
export const FrameExtraPx = 10;
// The "+" at the end of the strip, with its gap.
export const StripPlusPx = 26 + 2 * TabGapPx;

export type StripMode = "titles" | "icons" | "ticks";

export type StripLayout = { mode: StripMode; tabPx: number };

// How the strip draws its tabs in availPx (AC8): titles while every tab keeps a readable title, tightened down to
// TabMinTitlePx, then the icons alone, then the radar's ticks. The "+" and the frame always keep their room, so the
// strip never overflows nor scrolls.
export function stripLayout(count: number, availPx: number): StripLayout {
    if (!(count > 0)) {
        return { mode: "titles", tabPx: TabMaxPx };
    }
    const room = Math.max(0, availPx) - StripPlusPx - FrameExtraPx - (count - 1) * TabGapPx;
    const each = Math.floor(room / count);
    if (each >= TabMinTitlePx) {
        return { mode: "titles", tabPx: Math.min(TabMaxPx, each) };
    }
    if (each >= TabIconPx) {
        return { mode: "icons", tabPx: TabIconPx };
    }
    return { mode: "ticks", tabPx: 0 };
}

// The width a strip of count tabs takes at that layout (the ticks excluded: radarPitchPx sizes them).
export function stripWidthPx(count: number, layout: StripLayout): number {
    if (layout.mode === "ticks" || !(count > 0)) {
        return StripPlusPx;
    }
    return count * layout.tabPx + (count - 1) * TabGapPx + FrameExtraPx + StripPlusPx;
}

const KindKeys: Record<RadarKind, string> = {
    agent: "view360.strip.kinds.agent",
    term: "view360.strip.kinds.term",
    web: "view360.strip.kinds.web",
    companion: "view360.strip.kinds.companion",
    review: "view360.strip.kinds.review",
    project: "view360.strip.kinds.project",
    files: "view360.strip.kinds.files",
    other: "view360.strip.kinds.other",
};

// The strip's words, read in the interface language at each access (FR-I18N-001). It says "panel": a tab is only the
// shape (AC11).
export const StripText = {
    get add() {
        return t("view360.strip.add");
    },
    get close() {
        return t("view360.strip.close");
    },
    get moveLeft() {
        return t("view360.strip.moveLeft");
    },
    get moveRight() {
        return t("view360.strip.moveRight");
    },
    kind: (kind: RadarKind) => t(KindKeys[kind] ?? KindKeys.other),
    openedBy: (name: string) => t("view360.strip.openedBy", { name }),
};

// A tab's accessible name (AC10): its kind, its title and its state (visible or stored, and what it waits for).
export function carpetTabName(tick: RadarTick, agentName = ""): string {
    const state = [tick.visible ? t("view360.strip.visible") : t("view360.strip.stored")];
    if (tick.attention != null) {
        state.push(RadarText[tick.attention]);
    }
    if (agentName) {
        state.push(StripText.openedBy(agentName));
    }
    return t("view360.strip.tabName", { kind: StripText.kind(tick.kind), title: tick.title, state: state.join(", ") });
}

// The initial a page opened by an agent shows on its tab (AC3): the first letter of the agent's first name, never a
// provider's name (the name is the one MoltenTerm gave the agent).
export function agentInitial(name: string): string {
    const first = Array.from((name ?? "").trim())[0] ?? "";
    return first.toLocaleUpperCase();
}

// What the strip needs of a page's agent state (browser-agent.ts AgentTab): who holds the page and how it got it.
export type PageAgentTab = { agentname?: string; origin?: string };

// The agent that opened the page shown by a browser panel, "" when the developer opened it (or shared it).
export function pageOpener(activeTabId: string, agentTabs: Record<string, PageAgentTab>): string {
    const tab = activeTabId ? agentTabs?.[activeTabId] : null;
    if (tab == null || tab.origin !== "opened") {
        return "";
    }
    return (tab.agentname ?? "").trim();
}

// The tab the keyboard lands on (AC10, one tab in the tab order): the focused panel's, else the first visible one,
// else the first.
export function rovingColumnId(ticks: RadarTick[], focusedColumnId: string): string {
    if (!ticks?.length) {
        return null;
    }
    if (focusedColumnId != null && ticks.some((tick) => tick.columnId === focusedColumnId)) {
        return focusedColumnId;
    }
    return (ticks.find((tick) => tick.visible) ?? ticks[0]).columnId;
}

// ---- numbers (FR-SHELL-126-AC2) ---------------------------------------------------------------------------------

// Ctrl+Shift+1…9 stop at 9: a tab beyond them carries no number.
export const MaxTabNumber = 9;

// The numbers the tabs show while Ctrl and Shift are held, by column. A tab's number is the one its panel has for
// Ctrl+Shift+1…9 (the focus-number command: the panel's place in the layout, the agent's column first), so the keys
// and the tabs always agree. Nothing shows once either key is released or the window loses focus (held false).
export function tabNumbers(ticks: RadarTick[], leafNodeIds: string[], held: boolean): Record<string, number> {
    const rtn: Record<string, number> = {};
    if (!held) {
        return rtn;
    }
    for (const tick of ticks ?? []) {
        const at = (leafNodeIds ?? []).indexOf(tick.focusNodeId);
        if (at >= 0 && at < MaxTabNumber) {
            rtn[tick.columnId] = at + 1;
        }
    }
    return rtn;
}

// ---- order (AC5) ------------------------------------------------------------------------------------------------

// Where a dragged tab drops: the index, among the tabs in their current order, before which it goes (the tab itself
// still counted), from the centres of the tabs and the pointer.
export function dropIndex(centers: number[], x: number): number {
    if (!centers?.length || !Number.isFinite(x)) {
        return 0;
    }
    const at = centers.findIndex((c) => x < c);
    return at === -1 ? centers.length : at;
}

// The carpet order once the column moves before the column at toIndex (columnIds.length: at the end); null when it
// stays where it is.
export function reorderColumns(columnIds: string[], columnId: string, toIndex: number): string[] {
    const from = columnIds?.indexOf(columnId) ?? -1;
    if (from === -1 || !Number.isFinite(toIndex)) {
        return null;
    }
    const to = Math.min(Math.max(0, Math.round(toIndex)), columnIds.length);
    if (to === from || to === from + 1) {
        return null;
    }
    const rtn = columnIds.filter((id) => id !== columnId);
    rtn.splice(to > from ? to - 1 : to, 0, columnId);
    return rtn;
}

// The drop index of Move left (-1) or Move right (+1), null at that end of the carpet.
export function stepIndex(columnIds: string[], columnId: string, dir: -1 | 1): number {
    const from = columnIds?.indexOf(columnId) ?? -1;
    if (from === -1) {
        return null;
    }
    if (dir < 0) {
        return from > 0 ? from - 1 : null;
    }
    return from < columnIds.length - 1 ? from + 2 : null;
}

// The layout move that puts the carpet column before the carpet column at toIndex (or after the last one). The
// carpet's columns are top-level columns of the tree, among which pinned columns may sit: the column moves next to
// its new carpet neighbour, so the normal layout reads in the same order. Moving a column keeps its node, so its
// panels stay mounted and nothing reloads (the layout draws its leaves in id order). Null when nothing moves.
export function carpetMoveAction(
    rootNode: LayoutNode,
    columnIds: string[],
    columnId: string,
    toIndex: number
): LayoutTreeMoveNodeAction {
    if (reorderColumns(columnIds, columnId, toIndex) == null || !rootNode?.children?.length) {
        return null;
    }
    const children = rootNode.children;
    const node = children.find((child) => child.id === columnId);
    if (node == null) {
        return null;
    }
    const to = Math.min(Math.max(0, Math.round(toIndex)), columnIds.length);
    let index: number;
    if (to < columnIds.length) {
        index = children.findIndex((child) => child.id === columnIds[to]);
    } else {
        const last = children.findIndex((child) => child.id === columnIds[columnIds.length - 1]);
        index = last === -1 ? -1 : last + 1;
    }
    if (index === -1) {
        return null;
    }
    return { type: LayoutTreeActionType.Move, node, parentId: rootNode.id, index };
}

// ---- tab menu (AC6) ---------------------------------------------------------------------------------------------

export type CarpetTabMenuInput = {
    // The page's own actions (Reload, Duplicate, Copy link: browser-tab-menu.ts), empty for another panel.
    pageItems: ContextMenuItem[];
    // Pin beside / in the first column (view360-pin.tsx pinMenuItems).
    pinItems: ContextMenuItem[];
    canMoveLeft: boolean;
    canMoveRight: boolean;
    hasOthers: boolean;
    close: () => void;
    closeOthers: () => void;
    moveLeft: () => void;
    moveRight: () => void;
};

// The tab's menu: a page's actions first, then Close and Close others (the words of the former browser tabs,
// FR-SHELL-051), the pins, then Move left / right so reordering never needs a pointer. Unavailable entries are absent
// (FR-SHELL-049).
export function carpetTabMenu(input: CarpetTabMenuInput): ContextMenuItem[] {
    const menu: ContextMenuItem[] = [...(input.pageItems ?? [])];
    const group = (items: ContextMenuItem[]) => {
        if (!items.length) {
            return;
        }
        if (menu.length) {
            menu.push({ type: "separator" });
        }
        menu.push(...items);
    };
    const closing: ContextMenuItem[] = [{ label: t("browser.tabMenu.close"), icon: "xmark", click: input.close }];
    if (input.hasOthers) {
        closing.push({ label: t("browser.tabMenu.closeOthers"), icon: "xmark", click: input.closeOthers });
    }
    group(closing);
    group(input.pinItems ?? []);
    const moves: ContextMenuItem[] = [];
    if (input.canMoveLeft) {
        moves.push({ label: StripText.moveLeft, icon: "arrow-left", click: input.moveLeft });
    }
    if (input.canMoveRight) {
        moves.push({ label: StripText.moveRight, icon: "arrow-right", click: input.moveRight });
    }
    group(moves);
    return menu;
}
