// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

export const ContextMenuRoles = {
    undo: "undo",
    redo: "redo",
    cut: "cut",
    copy: "copy",
    paste: "paste",
    pasteAndMatchStyle: "pasteAndMatchStyle",
    delete: "delete",
    selectAll: "selectAll",
} as const;
export function contextMenuRole(role: unknown): keyof typeof ContextMenuRoles {
    return typeof role === "string" && Object.prototype.hasOwnProperty.call(ContextMenuRoles, role)
        ? (role as keyof typeof ContextMenuRoles)
        : null;
}
export function supportedMenuImage(source: unknown): boolean {
    if (typeof source !== "string" || source.length > 8 * 1024 * 1024) return false;
    if (/^data:image\/(?:png|jpeg|gif|webp|bmp|tiff|heic|svg\+xml)(?:;[^,]*)?,/i.test(source)) return true;
    try {
        return ["http:", "https:"].includes(new URL(source).protocol);
    } catch {
        return false;
    }
}
export function ownedMenuGuest(
    host: { id: number },
    guest: { isDestroyed: () => boolean; getType: () => string; hostWebContents?: { id: number } }
): boolean {
    return !!guest && !guest.isDestroyed() && guest.getType() === "webview" && guest.hostWebContents?.id === host.id;
}
