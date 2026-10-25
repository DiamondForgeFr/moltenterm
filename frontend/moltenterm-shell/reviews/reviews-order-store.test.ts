// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewsSortPref, ReviewsSortStorageKey } from "./reviews-order-store";

function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        data,
    };
}

describe("Reviews sort choice (FR-REV-001 AC13, FR-REV-024 AC-5)", () => {
    afterEach(() => {
        ReviewsSortPref.resetInstance();
        vi.unstubAllGlobals();
    });

    it("starts by state", () => {
        vi.stubGlobal("localStorage", memoryStorage());
        expect(globalStore.get(ReviewsSortPref.getInstance().sortAtom)).toBe("state");
    });

    it("remembers the developer's choice", () => {
        const storage = memoryStorage();
        vi.stubGlobal("localStorage", storage);
        ReviewsSortPref.getInstance().set("merge");
        expect(storage.data.get(ReviewsSortStorageKey)).toBe("merge");
        ReviewsSortPref.resetInstance();
        expect(globalStore.get(ReviewsSortPref.getInstance().sortAtom)).toBe("merge");
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
        const pref = ReviewsSortPref.getInstance();
        expect(globalStore.get(pref.sortAtom)).toBe("state");
        pref.set("merge");
        expect(globalStore.get(pref.sortAtom)).toBe("merge");
    });
});
