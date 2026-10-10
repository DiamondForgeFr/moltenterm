// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The rail's hover tray (FR-SHELL-045, DS-SHELL-080, DS-SHELL-081): a rail item extends into a 36 px tray inside the
// rail's layer, with its name, Edit and More. It replaces the buds of #365, #368, #276 and #390.
// One atom holds the open tray, by the key of its item: two trays can never be open, and a tray can never stay open on
// an item the pointer or the focus left. #390's buds were shown by CSS from :hover and :focus-visible, and a
// :focus-visible left behind by Escape kept them out on the wrong item.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";

// The pointer's intent: a tray opens once the pointer rests this long on its item.
export const RailTrayDwellMs = 250;
// Right after a tray folded, the next item's opens without the dwell, as the pointer moves down the rail.
export const RailTrayWarmMs = 300;
// The tray's width past its item: at least the name's room and the two buttons, at most this for a long name.
export const RailTrayMinReachPx = 112;
export const RailTrayMaxReachPx = 176;

export type RailTrayVia = "pointer" | "keyboard";

export type RailTrayOpen = { key: string; via: RailTrayVia };

export class RailTrayModel {
    private static instance: RailTrayModel = null;

    openAtom = atom(null) as PrimitiveAtom<RailTrayOpen>;
    dwellKey: string = null;
    dwellTimer: ReturnType<typeof setTimeout> = null;
    foldedAt = 0;
    // The tray whose More menu is open: leaving it for the menu does not fold it.
    pinnedKey: string = null;
    // The tray Escape folded: it stays folded while the pointer or the focus stays on its item.
    suppressedKey: string = null;
    // A rail item is being dragged: no tray opens under the pointer.
    dragging = false;

    private constructor() {}

    static getInstance(): RailTrayModel {
        if (RailTrayModel.instance == null) {
            RailTrayModel.instance = new RailTrayModel();
        }
        return RailTrayModel.instance;
    }

    static resetInstance(): void {
        RailTrayModel.instance?.cancelDwell();
        RailTrayModel.instance = null;
    }

    getOpen(): RailTrayOpen {
        return globalStore.get(this.openAtom);
    }

    isOpen(key: string): boolean {
        return this.getOpen()?.key === key;
    }

    cancelDwell() {
        clearTimeout(this.dwellTimer);
        this.dwellTimer = null;
        this.dwellKey = null;
    }

    open(key: string, via: RailTrayVia) {
        this.cancelDwell();
        if (this.suppressedKey === key) {
            this.suppressedKey = null;
        }
        const current = this.getOpen();
        if (current?.key === key && current.via === via) {
            return;
        }
        if (current != null && current.key !== key) {
            this.pinnedKey = null;
        }
        globalStore.set(this.openAtom, { key, via });
    }

    fold(key?: string, now = Date.now()) {
        const current = this.getOpen();
        if (current == null || (key != null && current.key !== key) || this.pinnedKey === current.key) {
            return;
        }
        globalStore.set(this.openAtom, null);
        this.foldedAt = now;
    }

    // Workspace switch, rail scroll, a drag, the window losing the focus: nothing stays open.
    closeAll(now = Date.now()) {
        this.cancelDwell();
        this.pinnedKey = null;
        this.fold(undefined, now);
    }

    setDragging(dragging: boolean) {
        this.dragging = dragging;
        if (dragging) {
            this.closeAll();
        }
    }

    pointerEnter(key: string, now = Date.now()) {
        if (this.dragging || this.suppressedKey === key) {
            return;
        }
        const current = this.getOpen();
        if (current?.key === key) {
            this.cancelDwell();
            return;
        }
        if (current != null || now - this.foldedAt < RailTrayWarmMs) {
            this.open(key, "pointer");
            return;
        }
        this.cancelDwell();
        this.dwellKey = key;
        this.dwellTimer = setTimeout(() => {
            this.dwellTimer = null;
            this.dwellKey = null;
            this.open(key, "pointer");
        }, RailTrayDwellMs);
    }

    pointerLeave(key: string, now = Date.now()) {
        if (this.dwellKey === key) {
            this.cancelDwell();
        }
        if (this.suppressedKey === key) {
            this.suppressedKey = null;
        }
        if (this.getOpen()?.via === "pointer") {
            this.fold(key, now);
        }
    }

    // A keyboard focus on the item (never a mouse focus: a click leaves the focus on the item).
    focusEnter(key: string) {
        if (this.suppressedKey === key) {
            return;
        }
        this.open(key, "keyboard");
    }

    focusLeave(key: string, now = Date.now()) {
        if (this.suppressedKey === key) {
            this.suppressedKey = null;
        }
        if (this.getOpen()?.via === "keyboard") {
            this.fold(key, now);
        }
    }

    // Escape folds the open tray, which stays folded until its item is left. Returns its key, null when none was open
    // (or its menu is: the menu takes the Escape).
    escape(now = Date.now()): string {
        const current = this.getOpen();
        if (current == null || this.pinnedKey === current.key) {
            return null;
        }
        this.cancelDwell();
        this.suppressedKey = current.key;
        this.fold(current.key, now);
        return current.key;
    }

    pin(key: string) {
        this.pinnedKey = key;
    }

    unpin(key: string) {
        if (this.pinnedKey === key) {
            this.pinnedKey = null;
        }
    }
}

// Where Left and Right go among the item (0) and its tray's buttons (1..count): the ends stay put.
export function trayArrowIndex(index: number, key: string, count: number): number {
    if (key === "ArrowRight") {
        return Math.min(index + 1, count);
    }
    if (key === "ArrowLeft") {
        return Math.max(index - 1, 0);
    }
    return index;
}

// The next rail item for Up, Down, Home and End, as an index among the rail's items; null for any other key.
export function railNavIndex(index: number, key: string, count: number): number {
    if (count === 0) {
        return null;
    }
    switch (key) {
        case "ArrowUp":
            return Math.max(index - 1, 0);
        case "ArrowDown":
            return Math.min(index + 1, count - 1);
        case "Home":
            return 0;
        case "End":
            return count - 1;
        default:
            return null;
    }
}

// The rail's one tab stop: the item last focused, else the active workspace's, else the first one.
export function railTabStop(keys: string[], last: string, active: string): string {
    if (last != null && keys.includes(last)) {
        return last;
    }
    if (active != null && keys.includes(active)) {
        return active;
    }
    return keys[0] ?? null;
}

export function railMoreLabel(name: string): string {
    return `More actions for ${name}`;
}

export function railEditLabel(name: string): string {
    return `Edit ${name}`;
}

export type RailWorkspaceMenu = {
    onEdit: () => void;
    // Set where MoltenTerm can keep the computer awake (FR-SHELL-023).
    coffee?: { label: string; on: boolean; onToggle: () => void };
    // Set for a saved workspace outside the project products (FR-MC-032).
    group?: { connecting: boolean; onGroupWith: () => void; onRemove?: () => void };
    // Set for the active workspace with a project (FR-SHELL-015).
    onProjectTab?: () => void;
    onReset: () => void;
    // Disabled with its reason on the last workspace (#222).
    remove: { enabled: boolean; reason?: string; onDelete: () => void };
};

// More (DS-SHELL-081): Edit first, reachable while the coffee's mug holds its place in the tray; then the coffee, the
// grouping, the Project tab, and the destructive pair last.
export function railWorkspaceMenu(menu: RailWorkspaceMenu): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: "Edit workspace…", icon: "pen", click: menu.onEdit }];
    const middle: ContextMenuItem[] = [];
    if (menu.coffee != null) {
        middle.push({
            label: menu.coffee.label,
            type: "checkbox",
            checked: menu.coffee.on,
            icon: "mug-hot",
            click: menu.coffee.onToggle,
        });
    }
    if (menu.group != null) {
        middle.push({
            label: menu.group.connecting ? "Stop grouping" : "Group with…",
            icon: "link",
            click: menu.group.onGroupWith,
        });
        if (menu.group.onRemove != null) {
            middle.push({ label: "Remove from group", icon: "link-slash", click: menu.group.onRemove });
        }
    }
    if (menu.onProjectTab != null) {
        middle.push({ label: "Open Project tab", icon: "folder-open", click: menu.onProjectTab });
    }
    if (middle.length > 0) {
        items.push({ type: "separator" }, ...middle);
    }
    items.push(
        { type: "separator" },
        { label: "Reset workspace…", icon: "rotate-left", click: menu.onReset },
        {
            label: "Delete workspace…",
            icon: "trash",
            destructive: true,
            enabled: menu.remove.enabled,
            sublabel: menu.remove.enabled ? undefined : menu.remove.reason,
            click: menu.remove.onDelete,
        }
    );
    return items;
}

export type RailGroupMenu = {
    collapsed: boolean;
    onToggle: () => void;
    // Set for a local group (FR-MC-032-AC6, AC7).
    local?: { connecting: boolean; onGroupWith: () => void; onRename: () => void; onUngroup: () => void };
};

export function railGroupMenu(menu: RailGroupMenu): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: menu.collapsed ? "Expand" : "Collapse", click: menu.onToggle }];
    if (menu.local == null) {
        return items;
    }
    items.push(
        { type: "separator" },
        {
            label: menu.local.connecting ? "Stop grouping" : "Add workspaces…",
            icon: "link",
            click: menu.local.onGroupWith,
        },
        { label: "Rename group…", icon: "pen", click: menu.local.onRename },
        { label: "Ungroup", icon: "layer-group", click: menu.local.onUngroup }
    );
    return items;
}
