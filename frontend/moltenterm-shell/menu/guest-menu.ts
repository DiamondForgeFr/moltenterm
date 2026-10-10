// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The icon column holds a glyph for every edit role (FR-SHELL-054); the role's label comes from MenuRoleLabels.
const RoleIcons: Record<string, string> = {
    undo: "rotate-left",
    redo: "rotate-right",
    cut: "scissors",
    copy: "copy",
    paste: "paste",
    selectAll: "i-cursor",
};

function role(name: string): ContextMenuItem {
    return { role: name, icon: RoleIcons[name] };
}

export function guestEditMenu(params: GuestContextMenu, saveImage: (token: string) => void): ContextMenuItem[] {
    const menu: ContextMenuItem[] = [];
    if (params.editable)
        menu.push(
            role("undo"),
            role("redo"),
            { type: "separator" },
            role("cut"),
            role("copy"),
            role("paste"),
            role("pasteAndMatchStyle"),
            role("selectAll")
        );
    else if (params.selectionText) menu.push(role("copy"));
    if (params.imageToken)
        menu.push({ label: "Save image", icon: "download", click: () => saveImage(params.imageToken) });
    return menu;
}
export function guestMenuEvent(params: GuestContextMenu, webview: HTMLElement): React.MouseEvent {
    const rect = webview.getBoundingClientRect();
    return {
        clientX: Number.isFinite(params.guestX) ? rect.left + params.guestX * (params.guestScale ?? 1) : params.x,
        clientY: Number.isFinite(params.guestY) ? rect.top + params.guestY * (params.guestScale ?? 1) : params.y,
        target: webview,
        contextMenuGuestId: params.guestId,
        contextMenuImageToken: params.imageToken,
        stopPropagation: () => {},
        preventDefault: () => {},
    } as unknown as React.MouseEvent;
}
