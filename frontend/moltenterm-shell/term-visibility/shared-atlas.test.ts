// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSharedTextureAtlas, registerAtlasClearer, registeredAtlasClearerCount } from "./shared-atlas";

const unregisters: Array<() => void> = [];

function register(clearer: () => void) {
    const unregister = registerAtlasClearer(clearer);
    unregisters.push(unregister);
    return unregister;
}

afterEach(() => {
    unregisters.splice(0).forEach((u) => u());
});

describe("shared texture atlas (#801)", () => {
    it("an atlas clear from one terminal refreshes every terminal sharing it, in the same pass", () => {
        const order: string[] = [];
        register(() => order.push("codex"));
        register(() => order.push("claude"));
        register(() => order.push("shell"));

        clearSharedTextureAtlas();

        expect(order).toEqual(["codex", "claude", "shell"]);
    });

    it("leaves out a terminal once it is unregistered (disposed, or back on the DOM renderer)", () => {
        const kept = vi.fn();
        const gone = vi.fn();
        register(kept);
        const unregisterGone = register(gone);
        expect(registeredAtlasClearerCount()).toBe(2);

        unregisterGone();
        clearSharedTextureAtlas();

        expect(kept).toHaveBeenCalledTimes(1);
        expect(gone).not.toHaveBeenCalled();
        expect(registeredAtlasClearerCount()).toBe(1);
    });

    it("a terminal that throws does not keep the others from refreshing", () => {
        const after = vi.fn();
        register(() => {
            throw new Error("renderer gone");
        });
        register(after);

        clearSharedTextureAtlas();

        expect(after).toHaveBeenCalledTimes(1);
    });

    it("refreshes nothing until an atlas is cleared", () => {
        const clearer = vi.fn();
        register(clearer);

        expect(clearer).not.toHaveBeenCalled();
    });
});
