// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

export const MenuRoleLabels: Record<string, string> = {
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    pasteAndMatchStyle: "Paste and Match Style",
    delete: "Delete",
    selectAll: "Select All",
};
export function menuLabel(item: ContextMenuItem): string {
    return item.label ?? MenuRoleLabels[item.role] ?? item.role ?? "";
}
export function visibleMenuItems(items: ContextMenuItem[]): ContextMenuItem[] {
    return items.filter((item) => item.visible !== false);
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
