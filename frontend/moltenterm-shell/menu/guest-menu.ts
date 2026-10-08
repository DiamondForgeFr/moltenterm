// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

export function guestEditMenu(params: GuestContextMenu, saveImage: (token: string) => void): ContextMenuItem[] {
    const menu: ContextMenuItem[] = [];
    if (params.editable)
        menu.push(
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "pasteAndMatchStyle" },
            { role: "selectAll" }
        );
    else if (params.selectionText) menu.push({ role: "copy" });
    if (params.imageToken)
        menu.push({ label: "Save Image", icon: "download", click: () => saveImage(params.imageToken) });
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
