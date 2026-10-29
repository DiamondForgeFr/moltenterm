// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// One menu per view, and pinned blocks reorder by drag (FR-SHELL-081, DS-SHELL-126): what the view menu offers in each
// state, a view's glyph (its panels' icons separated by a slash, or the icon the developer chose), and where a dragged
// block lands. Kept apart from the components so the rules can be tested without the app.

import { DefaultAgentGlyph, DefaultTabIcon, panelIcon } from "../tab-identity";
import { AgentSlotMetaKey, PinConfig, PinNode, ViewIconMetaKey, viewMoves, ViewState } from "./view-pins-model";

export { ViewIconMetaKey };

// A combination shows at most this many of its panels' icons.
export const MaxGlyphIcons = 3;

// The glyphs the icon menu offers (the #1181 prototype's set, in Font Awesome Free).
export const ViewIconChoices = [
    "gauge",
    "code-pull-request",
    "server",
    "diagram-project",
    "terminal",
    "robot",
    "globe",
    "file-lines",
    "brands@github",
    "envelope",
    "calendar",
    "table-columns",
    "wand-magic-sparkles",
    "layer-group",
    "box-archive",
    "gear",
];

export function readViewIcon(value: any): string {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// A chosen icon replaces the panels' icons; otherwise the first three panels' icons, in order. A view without a
// panel shows the default square.
export function viewGlyphIcons(chosen: string, panelIcons: string[]): string[] {
    const icon = readViewIcon(chosen);
    if (icon != null) {
        return [icon];
    }
    const icons = (panelIcons ?? []).filter((i) => !!i).slice(0, MaxGlyphIcons);
    return icons.length > 0 ? icons : [DefaultTabIcon];
}

// A panel's icon: the agent's glyph when an agent runs in it (agentIcon), a slot kept for an agent, or its view's.
export function paneIcon(meta: Record<string, any>, agentIcon?: string): string {
    if (agentIcon) {
        return agentIcon;
    }
    if (meta?.[AgentSlotMetaKey]) {
        return DefaultAgentGlyph;
    }
    return panelIcon(meta);
}

function treePanes(node: PinNode): number[] {
    if (node == null) {
        return [];
    }
    if (node.children?.length) {
        return node.children.flatMap(treePanes);
    }
    return node.pane != null ? [node.pane] : [];
}

// The panels' icons of a configuration, in the order of its layout.
export function configPaneIcons(config: PinConfig): string[] {
    if (config == null) {
        return [];
    }
    return treePanes(config.tree).map((i) => paneIcon(config.panes[i]));
}

// A stored layout and the tab's panels: the panels the tree lacks (added while the view was not on screen, or a view
// never shown, such as a duplicate made in the background) join it on the right. Panels the tab no longer has leave.
export function withMissingPanels(tree: PinNode, blockIds: string[]): PinNode {
    const ids = new Set(blockIds ?? []);
    const prune = (node: PinNode): PinNode => {
        if (node == null) {
            return null;
        }
        if (node.children?.length) {
            const children = node.children.map(prune).filter((c) => c != null);
            if (children.length === 0) {
                return null;
            }
            return children.length === 1 ? children[0] : { ...node, children };
        }
        return node.blockid && ids.has(node.blockid) ? node : null;
    };
    const kept = prune(tree);
    const present = new Set<string>();
    const walk = (node: PinNode) => {
        if (node?.children?.length) {
            node.children.forEach(walk);
        } else if (node?.blockid) {
            present.add(node.blockid);
        }
    };
    walk(kept);
    const missing = (blockIds ?? []).filter((id) => !present.has(id)).map((blockid) => ({ blockid }));
    const all = kept != null ? [kept, ...missing] : missing;
    if (all.length === 0) {
        return null;
    }
    return all.length === 1 ? all[0] : { dir: "row", children: all };
}

// What the view menu offers (FR-SHELL-081): never an action the state forbids, and exactly the two states the view is
// not in (#1244). A temporary view's pins open the pin page (#1184); a pinned view moves at once.
export type ViewMenuPlan = {
    saveOrRevert: boolean;
    pinHere: boolean;
    pinEverywhere: boolean;
    pinOnlyHere: boolean;
    makeTemporary: boolean;
    close: boolean;
    // A pinned view says it closes only once made temporary.
    closeNote: boolean;
    // A temporary view made from a changed view pinned everywhere, while its pin exists (#1272).
    updatePinned: boolean;
};

// projectTab: MoltenTerm's own Project tab, which stays pinned in its workspace (viewMoves) and still closes: a closed
// Project tab is not made again until asked (FR-SHELL-015). fromPin: the view came from a pin that still exists.
export function viewMenuPlan(state: ViewState, modified: boolean, projectTab = false, fromPin = false): ViewMenuPlan {
    const temporary = state === "temporary";
    const moves = viewMoves(state, projectTab);
    return {
        saveOrRevert: modified && !temporary && !projectTab,
        pinHere: temporary && moves.includes("workspace"),
        pinEverywhere: moves.includes("everywhere"),
        pinOnlyHere: state === "everywhere" && moves.includes("workspace"),
        makeTemporary: moves.includes("temporary"),
        close: temporary || projectTab,
        closeNote: !temporary && !projectTab,
        updatePinned: temporary && fromPin && !projectTab,
    };
}

// The states the menu's move items lead to, in the menu's order.
export function menuMoveTargets(plan: ViewMenuPlan): ViewState[] {
    const rtn: ViewState[] = [];
    if (plan.pinHere || plan.pinOnlyHere) {
        rtn.push("workspace");
    }
    if (plan.pinEverywhere) {
        rtn.push("everywhere");
    }
    if (plan.makeTemporary) {
        rtn.push("temporary");
    }
    return rtn;
}

// The menu's header, "<name> · <state>", in the words of the sidebar's sections.
export function viewMenuHeader(
    name: string,
    state: ViewState,
    workspace: string,
    t: (key: string, vars?: Record<string, any>) => string
): string {
    return `${name} · ${t(`sidebar.pins.menu.state.${state}`, { workspace })}`;
}

// The list once the dragged id lands beside the target: before it, or after it. Other ids keep their place.
export function moveBeside(ids: readonly string[], dragged: string, target: string, after: boolean): string[] {
    if (dragged === target || !ids.includes(dragged) || !ids.includes(target)) {
        return [...ids];
    }
    const rest = ids.filter((id) => id !== dragged);
    const at = rest.indexOf(target) + (after ? 1 : 0);
    return [...rest.slice(0, at), dragged, ...rest.slice(at)];
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((id, i) => id === b[i]);
}

// Undo of a reorder: the order before it, when the same ids are still there; null when the list changed meanwhile.
export function undoOrder(before: readonly string[], now: readonly string[]): string[] {
    if (before.length !== now.length || !before.every((id) => now.includes(id))) {
        return null;
    }
    return [...before];
}

// A drag in the sidebar: a tile, a block of the top row, or a temporary view's row.
export type DragKind = "tile" | "top" | "row";
export type DropZone = "tiles" | "top" | "temporary";
export type DropAction =
    | "reorder-tiles"
    | "reorder-top"
    | "pin-here"
    | "pin-everywhere"
    | "pin-only-here"
    | "make-temporary";

// What a drop on a zone does: a tile among the tiles or a block among the top row reorders; a temporary view on the
// tiles is pinned in the workspace, a top-row block there is pinned only in it; a tile or a temporary view on the top
// row is pinned everywhere; a tile or a top-row block on the temporary list becomes temporary (#1244). A temporary
// row on its own list reorders through the list itself.
export function dropAction(kind: DragKind, zone: DropZone): DropAction {
    if (zone === "tiles") {
        return kind === "tile" ? "reorder-tiles" : kind === "row" ? "pin-here" : "pin-only-here";
    }
    if (zone === "top") {
        return kind === "top" ? "reorder-top" : "pin-everywhere";
    }
    if (zone === "temporary") {
        return kind === "row" ? null : "make-temporary";
    }
    return null;
}

// The drop moves the view to another state, rather than reordering its section.
export function isMoveAction(action: DropAction): boolean {
    return action != null && action !== "reorder-tiles" && action !== "reorder-top";
}

// A zone shows its scope caption while it would move the dragged view; the row being reordered hides its own.
export function zoneCaptionShown(kind: DragKind, zone: DropZone): boolean {
    return isMoveAction(dropAction(kind, zone));
}

// The side of the target the dragged block lands on, from the pointer: past its middle, after it.
export function dropsAfter(clientX: number, rect: { left: number; width: number }): boolean {
    return clientX > rect.left + rect.width / 2;
}

// ⌘Z (Ctrl+Z elsewhere) undoes the sidebar's last change while its toast shows, unless the focus types text (a field,
// an editor, a terminal), which keeps its own undo.
export function undoKey(
    e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
    mac: boolean
): boolean {
    if (e.key?.toLowerCase() !== "z" || e.shiftKey || e.altKey) {
        return false;
    }
    return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

// Whether the focused element keeps ⌘Z for itself. A terminal does not on macOS (#1345): the pty never receives ⌘, and
// the view that follows ⌘W is usually a terminal, where ⌘Z has to undo the close. Ctrl+Z stays the shell's elsewhere.
export function keepsUndoKey(el: Element, mac: boolean): boolean {
    if (mac && el?.closest?.(".xterm") != null) {
        return false;
    }
    return typesText(el);
}

export function typesText(el: Element): boolean {
    if (el == null) {
        return false;
    }
    const tag = el.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
        return true;
    }
    if ((el as HTMLElement).isContentEditable) {
        return true;
    }
    return el.closest?.(".xterm, .monaco-editor, .cm-editor, webview") != null;
}
