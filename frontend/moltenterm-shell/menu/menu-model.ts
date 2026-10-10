// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { isMacOS } from "@/util/platformutil";

// An Electron accelerator ("Command+Shift+D") as the menus show it (⇧⌘D on macOS).
export function shortcutLabel(accelerator: string): string {
    if (!accelerator) return "";
    if (!isMacOS()) return accelerator.replace(/Control/g, "Ctrl").replace(/Super/g, "Meta");
    return accelerator
        .replace(/Control\+/g, "⌃")
        .replace(/(?:Option|Alt)\+/g, "⌥")
        .replace(/Shift\+/g, "⇧")
        .replace(/(?:Command|Cmd)\+/g, "⌘");
}

export const MenuRoleLabels: Record<string, string> = {
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    pasteAndMatchStyle: "Paste and match style",
    delete: "Delete",
    selectAll: "Select all",
};
export function menuLabel(item: ContextMenuItem): string {
    return item.label ?? MenuRoleLabels[item.role] ?? item.role ?? "";
}
export function visibleMenuItems(items: ContextMenuItem[]): ContextMenuItem[] {
    return items.filter((item) => item.visible !== false);
}

export const DeveloperSection = "Developer";

type MenuGroup = { section: string; items: ContextMenuItem[] };

// FR-SHELL-054 (DS-SHELL-095): items declare a section and the host draws the headings. A separator or a new section
// starts a group; an item without a section continues the group before it. Groups of one section merge, the
// Developer section (shown only while Option is held) and then any group holding a destructive item go last, and
// separators only part unnamed groups: never two in a row, none at the ends. Hidden items are dropped, never shown
// disabled in their place.
export function layoutMenuItems(items: ContextMenuItem[], opts: { developer?: boolean } = {}): ContextMenuItem[] {
    const groups: MenuGroup[] = [];
    let current: MenuGroup = null;
    const start = (section: string) => {
        const named = section !== "" ? groups.find((g) => g.section === section) : null;
        current = named ?? { section, items: [] };
        if (named == null) groups.push(current);
    };
    for (const item of items ?? []) {
        if (item.visible === false) continue;
        if (item.type === "separator") {
            current = null;
            continue;
        }
        if (item.type === "header") {
            start(menuLabel(item));
            continue;
        }
        if (item.section === DeveloperSection && !opts.developer) continue;
        if (current == null || (item.section != null && item.section !== current.section)) start(item.section ?? "");
        current.items.push(item);
    }
    const filled = groups.filter((g) => g.items.length > 0);
    const rank = (g: MenuGroup) => (g.items.some((i) => i.destructive) ? 2 : g.section === DeveloperSection ? 1 : 0);
    const ordered = [0, 1, 2].flatMap((r) => filled.filter((g) => rank(g) === r));
    return ordered.flatMap((group, index) => {
        const lead: ContextMenuItem[] = [];
        // A heading parts sections: a menu of one section needs none.
        if (group.section && ordered.length > 1) lead.push({ type: "header", label: group.section });
        else if (index > 0) lead.push({ type: "separator" });
        return [...lead, ...group.items];
    });
}

// The same layout at every depth, for the native menus (app:nativecontextmenu), which take the menu whole.
export function layoutMenuTree(items: ContextMenuItem[], opts: { developer?: boolean } = {}): ContextMenuItem[] {
    return layoutMenuItems(items, opts).map((item) =>
        item.submenu ? { ...item, submenu: layoutMenuTree(item.submenu, opts) } : item
    );
}

// A menu asked for from the keyboard (the host's Shift+F10 or Menu key, or a button pressed with Enter or Space: a
// click without pointer detail) focuses its first row; one opened by the pointer has no active row.
export function menuOpenedByKeyboard(event: { type?: string; detail?: number }, fromKeys: boolean): boolean {
    if (fromKeys) return true;
    return event?.type === "click" && event.detail === 0;
}
export function actionableMenuItem(item: ContextMenuItem): boolean {
    return item.enabled !== false && item.type !== "header" && item.type !== "separator";
}
export function menuHasRoles(items: ContextMenuItem[]): boolean {
    return items.some((item) => !!item.role || menuHasRoles(item.submenu ?? []));
}
export function menuItemRole(item: ContextMenuItem): string {
    if (item.type === "checkbox") return "menuitemcheckbox";
    if (item.type === "radio") return "menuitemradio";
    return "menuitem";
}
export function menuPoint(event: { clientX?: number; clientY?: number; target?: EventTarget }): {
    x: number;
    y: number;
} {
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) return { x: event.clientX, y: event.clientY };
    const element = event.target as HTMLElement;
    const rect = element?.getBoundingClientRect?.();
    return { x: rect?.left ?? 8, y: rect?.bottom ?? 8 };
}
export function captureMenuFocus(): () => void {
    const element = document.activeElement as HTMLElement;
    const selection = window.getSelection();
    const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, i) => selection.getRangeAt(i).cloneRange());
    const input = element as HTMLInputElement;
    let inputRange: [number, number, "forward" | "backward" | "none"];
    try {
        if (input.selectionStart != null)
            inputRange = [input.selectionStart, input.selectionEnd, input.selectionDirection];
    } catch {
        /* Some input types do not expose selection. */
    }
    return () => {
        if (!element?.isConnected) return;
        element.focus({ preventScroll: true });
        if (inputRange) input.setSelectionRange(...inputRange);
        if (ranges.every((range) => range.startContainer.isConnected && range.endContainer.isConnected)) {
            selection?.removeAllRanges();
            ranges.forEach((range) => selection?.addRange(range));
        }
    };
}

export function runMenuSelection(
    selecting: { current: boolean },
    restore: () => void,
    select: () => void,
    cleanup: () => void
): void {
    selecting.current = true;
    try {
        restore();
        select();
    } finally {
        selecting.current = false;
        cleanup();
    }
}
