// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { liveWebContentsFromId } from "./moltenterm-webcontents-id";

const env = vi.hoisted(() => ({
    contents: new Map<number, any>(),
    fromId: null as (id: number) => any,
}));
vi.mock("electron", () => ({ webContents: { fromId: (id: number) => env.fromId(id) } }));

function strictFromId(id: number) {
    // Electron's own conversion: anything but an integer is "conversion failure from <type>".
    if (typeof id !== "number" || !Number.isInteger(id)) throw new TypeError(`conversion failure from ${typeof id}`);
    return env.contents.get(id);
}

beforeEach(() => {
    env.contents.clear();
    env.fromId = vi.fn(strictFromId);
});

describe("liveWebContentsFromId (#928)", () => {
    it("returns live contents for their id", () => {
        const wc = { isDestroyed: () => false };
        env.contents.set(3, wc);
        expect(liveWebContentsFromId(3)).toBe(wc);
    });

    it("returns null without calling fromId for an id that is not a safe integer", () => {
        for (const id of [undefined, null, "3", 3.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}]) {
            expect(liveWebContentsFromId(id)).toBeNull();
        }
        expect(env.fromId).not.toHaveBeenCalled();
    });

    it("returns null for an unknown or destroyed id, and when fromId throws", () => {
        env.contents.set(4, { isDestroyed: () => true });
        expect(liveWebContentsFromId(4)).toBeNull();
        expect(liveWebContentsFromId(5)).toBeNull();
        env.fromId = () => {
            throw new TypeError("conversion failure from undefined");
        };
        expect(liveWebContentsFromId(6)).toBeNull();
    });
});
