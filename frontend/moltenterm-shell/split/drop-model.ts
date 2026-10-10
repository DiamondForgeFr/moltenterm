// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Drag to split (FR-SHELL-060, DS-SHELL-102): the rules, pure so they are tested without the app. drop-zones.ts
// follows the drag and carries the drop out on the layout.

import { MinPanelPx, SplitDirection } from "./split-model";

export type DropKind = "tab" | "file" | "session";
export type DropZone = SplitDirection | "center";

export type Rect = { left: number; top: number; width: number; height: number };

// The outer strips of a panel each belong to their side; the rest is the centre (DS-SHELL-102).
export const EdgeShare = 0.25;

// The HTML5 type a Sessions row carries while it is dragged. Not text/plain: react-dnd would take it for a native
// text drag and Wave's drop targets (the AI panel) would answer it.
export const SessionDragType = "application/x-molten-session";

// What is dragged.
export type TabDragItem = { kind: "tab"; tabId: string; name: string };
export type FileDragItem = { kind: "file"; path: string; connection: string; name: string; isDir: boolean };
export type SessionDragItem = { kind: "session"; id: string; name: string };
export type DragItem = TabDragItem | FileDragItem | SessionDragItem;

// The panel under the pointer, as the drop needs it.
export type DropTarget = {
    blockId: string;
    rect: Rect;
    view: string;
    connection?: string;
    // A preview that lists a folder: Wave's own drop copies a dragged file into it.
    folder?: boolean;
};

export type DropAction =
    | { type: "move-tab-panel"; tabId: string; targetBlockId: string; direction: SplitDirection }
    | { type: "open-file"; targetBlockId: string; direction: SplitDirection; blockDef: BlockDef }
    | { type: "open-file-here"; targetBlockId: string; path: string; connection: string }
    | { type: "resume-session"; id: string; targetBlockId: string; direction: SplitDirection };

// The zone under the pointer: the side whose strip it is in (the nearer side in a corner), else the centre when it is
// offered, else none. A side the panel is too small to split along is not offered either.
export function dropZoneAt(x: number, y: number, rect: Rect, centerOffered: boolean): DropZone {
    if (rect == null || !(rect.width > 0) || !(rect.height > 0)) {
        return null;
    }
    const fx = (x - rect.left) / rect.width;
    const fy = (y - rect.top) / rect.height;
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) {
        return null;
    }
    const sides: [SplitDirection, number][] = [
        ["left", fx],
        ["right", 1 - fx],
        ["up", fy],
        ["down", 1 - fy],
    ];
    let best: [SplitDirection, number] = null;
    for (const side of sides) {
        if (best == null || side[1] < best[1]) {
            best = side;
        }
    }
    if (best[1] < EdgeShare) {
        const length = best[0] === "left" || best[0] === "right" ? rect.width : rect.height;
        return length >= 2 * MinPanelPx ? best[0] : null;
    }
    return centerOffered ? "center" : null;
}

// The ghost of the new panel for a zone, in the panel's own coordinates: the half on that side, as the split handle's
// ghost at 50 % (DS-SHELL-083); the whole panel for the centre.
export function zoneGhostRect(zone: DropZone, width: number, height: number): Rect {
    const halfW = width / 2;
    const halfH = height / 2;
    switch (zone) {
        case "left":
            return { left: 0, top: 0, width: halfW, height };
        case "right":
            return { left: halfW, top: 0, width: width - halfW, height };
        case "up":
            return { left: 0, top: 0, width, height: halfH };
        case "down":
            return { left: 0, top: halfH, width, height: height - halfH };
        case "center":
            return { left: 0, top: 0, width, height };
    }
    return null;
}

// The centre means "open in this panel" and is offered only where that replaces nothing: a file over a preview showing
// a file on the same connection (the preview's history keeps the previous one). A preview listing a folder keeps
// Wave's own drop there (it copies the file into the folder); a tab or a session has no "open here".
export function centerOffered(item: DragItem, target: DropTarget): boolean {
    if (item?.kind !== "file" || target == null || item.isDir) {
        return false;
    }
    return target.view === "preview" && !target.folder && sameConnection(item.connection, target.connection);
}

export function sameConnection(a: string, b: string): boolean {
    const norm = (c: string) => (c == null || c === "" || c === "local" ? "" : c);
    return norm(a) === norm(b);
}

// The panels a drag offers zones on. A tab dragged over its own panels has nowhere to go (it is the tab shown).
export function targetAllowed(item: DragItem, activeTabId: string): boolean {
    if (item == null) {
        return false;
    }
    if (item.kind === "tab") {
        return item.tabId !== activeTabId;
    }
    return true;
}

// What a drop does (FR-SHELL-060): a tab's main panel moves into the split, a file opens in a preview split (or in
// the preview under the pointer, at the centre), a session resumes in a terminal split.
export function dropAction(item: DragItem, zone: DropZone, target: DropTarget): DropAction {
    if (item == null || zone == null || target == null) {
        return null;
    }
    if (zone === "center") {
        if (item.kind !== "file" || !centerOffered(item, target)) {
            return null;
        }
        return { type: "open-file-here", targetBlockId: target.blockId, path: item.path, connection: item.connection };
    }
    switch (item.kind) {
        case "tab":
            return { type: "move-tab-panel", tabId: item.tabId, targetBlockId: target.blockId, direction: zone };
        case "file":
            return { type: "open-file", targetBlockId: target.blockId, direction: zone, blockDef: fileBlockDef(item) };
        case "session":
            return { type: "resume-session", id: item.id, targetBlockId: target.blockId, direction: zone };
    }
    return null;
}

export function fileBlockDef(item: FileDragItem): BlockDef {
    const meta: MetaType = { view: "preview", file: item.path };
    if (!sameConnection(item.connection, "")) {
        meta.connection = item.connection;
    }
    return { meta };
}

// A file row of Wave's file browser carries a wsh:// URI (formatRemoteUri: "wsh://<connection>/<path>", the path
// absolute or from ~).
export function fileItemFromDragged(file: { uri: string; relName: string; isDir: boolean }): FileDragItem {
    const uri = file?.uri ?? "";
    const prefix = "wsh://";
    if (!uri.startsWith(prefix)) {
        return null;
    }
    const rest = uri.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) {
        return null;
    }
    const connection = rest.slice(0, slash);
    const path = rest.slice(slash + 1);
    if (path === "") {
        return null;
    }
    return { kind: "file", path, connection, name: file.relName ?? path, isDir: !!file.isDir };
}

// A tab is dragged onto the panels once the pointer is this far below the tab strip; back on the strip, it reorders
// the tabs again.
export const TabDragOutPx = 12;

export function tabDraggedOut(pointerY: number, stripBottom: number): boolean {
    return pointerY > stripBottom + TabDragOutPx;
}

// The new panel's layout size after a split laid out by the backend (a resumed session): both panels take half of
// the target's size, so the other panels of the row keep theirs (as splitPanel does).
export function halfSizes(targetSize: number): { target: number; added: number } {
    const size = Number.isFinite(targetSize) && targetSize > 0 ? targetSize : 10;
    return { target: size / 2, added: size / 2 };
}
