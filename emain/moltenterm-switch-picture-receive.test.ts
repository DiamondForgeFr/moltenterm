// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The page's end of the switch picture's transport (#2375): what the preload puts on the page, and what it refuses.

import { describe, expect, it, vi } from "vitest";
import { PictureAttribute, PictureChannel } from "./moltenterm-switch-picture";
import {
    MaxPictureBytes,
    PictureMimes,
    PictureReceiverDeps,
    PictureRoot,
    receivePicture,
    RevokeAfterMs,
} from "./moltenterm-switch-picture-receive";

function fakeRoot(): PictureRoot & { attrs: Map<string, string> } {
    const attrs = new Map<string, string>();
    return {
        attrs,
        getAttribute: (name) => attrs.get(name) ?? null,
        setAttribute: (name, value) => {
            attrs.set(name, value);
        },
    };
}

function fakeDeps() {
    const created: string[] = [];
    const revoked: string[] = [];
    const later: { fn: () => void; ms: number }[] = [];
    const deps: PictureReceiverDeps = {
        createUrl: (mime, bytes) => {
            const url = `blob:${mime}:${bytes.byteLength}:${created.length}`;
            created.push(url);
            return url;
        },
        revokeUrl: (url) => {
            revoked.push(url);
        },
        later: (fn, ms) => {
            later.push({ fn, ms });
        },
    };
    return { deps, created, revoked, later };
}

describe("the picture a page receives (#2375)", () => {
    it("puts a blob URL of the bytes on the page's root, under the attribute the scripts read", () => {
        const root = fakeRoot();
        const { deps, created } = fakeDeps();
        expect(receivePicture(root, "image/png", new Uint8Array(10), deps)).toBe(true);
        expect(root.getAttribute(PictureAttribute)).toBe(created[0]);
        expect(PictureAttribute).toBe("data-mt-picture");
        expect(PictureChannel).toBe("moltenterm-switch-picture");
    });

    it("revokes the picture a newer one replaces, once what showed it has loaded", () => {
        const root = fakeRoot();
        const { deps, created, revoked, later } = fakeDeps();
        receivePicture(root, "image/png", new Uint8Array(10), deps);
        receivePicture(root, "image/jpeg", new Uint8Array(20), deps);
        expect(root.getAttribute(PictureAttribute)).toBe(created[1]);
        expect(later).toHaveLength(1);
        expect(later[0].ms).toBe(RevokeAfterMs);
        expect(revoked).toEqual([]);
        later[0].fn();
        expect(revoked).toEqual([created[0]]);
    });

    it("takes only the formats main encodes", () => {
        expect([...PictureMimes]).toEqual(["image/png", "image/jpeg"]);
        for (const mime of ["image/svg+xml", "text/html", "", null, undefined, 3]) {
            const root = fakeRoot();
            const { deps, created } = fakeDeps();
            expect(receivePicture(root, mime, new Uint8Array(10), deps)).toBe(false);
            expect(created).toEqual([]);
        }
    });

    it("takes only bytes of a bounded size", () => {
        const root = fakeRoot();
        const { deps, created } = fakeDeps();
        for (const bytes of [null, "AAAA", [1, 2, 3], {}, new Uint8Array(0), new Uint8Array(MaxPictureBytes + 1)]) {
            expect(receivePicture(root, "image/png", bytes, deps)).toBe(false);
        }
        expect(created).toEqual([]);
        expect(root.getAttribute(PictureAttribute)).toBeNull();
        expect(receivePicture(root, "image/png", new Uint8Array(MaxPictureBytes), deps)).toBe(true);
    });

    it("does nothing without a page", () => {
        const { deps } = fakeDeps();
        expect(receivePicture(null, "image/png", new Uint8Array(10), deps)).toBe(false);
    });

    it("makes a real blob URL and revokes it later, by default", () => {
        const created: string[] = [];
        const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation((blob: any) => {
            created.push(`blob:${blob.type}`);
            return "blob:default";
        });
        const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        vi.useFakeTimers();
        try {
            const root = fakeRoot();
            expect(receivePicture(root, "image/png", new Uint8Array(4))).toBe(true);
            expect(receivePicture(root, "image/png", new Uint8Array(4))).toBe(true);
            expect(created).toEqual(["blob:image/png", "blob:image/png"]);
            vi.advanceTimersByTime(RevokeAfterMs);
            expect(revoke).toHaveBeenCalledWith("blob:default");
        } finally {
            vi.useRealTimers();
            createObjectURL.mockRestore();
            revoke.mockRestore();
        }
    });
});
