// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The page's end of the switch picture's transport (#2375, emain/moltenterm-switch-picture.ts): Electron main sends a
// picture's bytes, the preload makes a blob URL of them and puts it on the page's root, where the scripts main runs
// read it. Bytes in a message cost a copy; the same picture inlined in a script costs tens of milliseconds of parsing
// on the page's main thread, in front of the reinit a switch waits for.

import { PictureAttribute } from "./moltenterm-switch-picture";

// What a picture can be: the two formats main encodes, and a size well above the largest one it keeps.
export const PictureMimes: readonly string[] = ["image/png", "image/jpeg"];
export const MaxPictureBytes = 8 * 1024 * 1024;
// A picture replaced by a newer one is revoked after this, once whatever showed it has loaded.
export const RevokeAfterMs = 5000;

export type PictureReceiverDeps = {
    createUrl(mime: string, bytes: Uint8Array): string;
    revokeUrl(url: string): void;
    later(fn: () => void, ms: number): void;
};

export type PictureRoot = {
    getAttribute(name: string): string;
    setAttribute(name: string, value: string): void;
};

export function liveReceiverDeps(): PictureReceiverDeps {
    return {
        createUrl: (mime, bytes) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })),
        revokeUrl: (url) => URL.revokeObjectURL(url),
        later: (fn, ms) => {
            setTimeout(fn, ms);
        },
    };
}

// Whether it was taken. Only what main sends reaches here (an ipcRenderer listener), and still nothing but a known image
// format of a bounded size is put on the page.
export function receivePicture(
    root: PictureRoot,
    mime: unknown,
    bytes: unknown,
    deps: PictureReceiverDeps = liveReceiverDeps()
): boolean {
    if (root == null || typeof mime !== "string" || !PictureMimes.includes(mime)) {
        return false;
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MaxPictureBytes) {
        return false;
    }
    const url = deps.createUrl(mime, bytes);
    const previous = root.getAttribute(PictureAttribute);
    root.setAttribute(PictureAttribute, url);
    if (previous) {
        deps.later(() => deps.revokeUrl(previous), RevokeAfterMs);
    }
    return true;
}
