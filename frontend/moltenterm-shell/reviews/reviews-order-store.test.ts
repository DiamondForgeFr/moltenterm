// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MergeOrderPref, MergeOrderStorageKey } from "./reviews-order-store";

function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        data,
    };
}

describe("merge order choice (FR-REV-024 AC-5)", () => {
    afterEach(() => {
        MergeOrderPref.resetInstance();
        vi.unstubAllGlobals();
    });

    it("starts on the suggested order", () => {
        vi.stubGlobal("localStorage", memoryStorage());
        expect(globalStore.get(MergeOrderPref.getInstance().choiceAtom)).toBe("suggested");
    });

    it("remembers the developer's choice", () => {
        const storage = memoryStorage();
        vi.stubGlobal("localStorage", storage);
        MergeOrderPref.getInstance().set("list");
        expect(storage.data.get(MergeOrderStorageKey)).toBe("list");
        MergeOrderPref.resetInstance();
        expect(globalStore.get(MergeOrderPref.getInstance().choiceAtom)).toBe("list");
    });

    it("works without storage", () => {
        vi.stubGlobal("localStorage", {
            getItem: () => {
                throw new Error("blocked");
            },
            setItem: () => {
                throw new Error("blocked");
            },
        });
        const pref = MergeOrderPref.getInstance();
        expect(globalStore.get(pref.choiceAtom)).toBe("suggested");
        pref.set("list");
        expect(globalStore.get(pref.choiceAtom)).toBe("list");
    });
});
