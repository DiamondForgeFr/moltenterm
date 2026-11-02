// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The settings as wavesrv holds them: a write lands in settings.json and comes back to every page as the full config.
const backend = vi.hoisted(() => ({
    writes: [] as Record<string, unknown>[],
    fail: false,
}));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    const fullConfigAtom = atom(null);
    const settingsAtom = atom((get) => (get(fullConfigAtom) as any)?.settings ?? {});
    const keyAtoms = new Map<string, any>();
    return {
        atoms: { fullConfigAtom, settingsAtom },
        getSettingsKeyAtom: (key: string) => {
            if (!keyAtoms.has(key)) {
                keyAtoms.set(
                    key,
                    atom((get) => (get(settingsAtom) as any)[key])
                );
            }
            return keyAtoms.get(key);
        },
    };
});
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetConfigCommand: async (_client: unknown, data: Record<string, unknown>) => {
            if (backend.fail) {
                throw new Error("no backend");
            }
            backend.writes.push(data);
            publish({ ...settings(), ...data });
        },
    },
}));

import { atoms } from "@/app/store/global";
import { MergedOpenPref } from "./reviews-merged-model";
import {
    LegacyMergedOpenStorageKey,
    LegacySortStorageKey,
    migrateLegacy,
    resetMigration,
    ReviewsFolds,
    ReviewsFoldsKey,
    ReviewsSortKey,
    ReviewsSortPref,
    sectionOpen,
} from "./reviews-order-store";

function settings(): Record<string, unknown> {
    return (globalStore.get(atoms.fullConfigAtom) as any)?.settings ?? {};
}

// What every page receives when the settings change, its own write included.
function publish(next: Record<string, unknown>) {
    globalStore.set(atoms.fullConfigAtom as any, { settings: next });
}

function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
        data,
    };
}

// A new page: its own instances, which only know what the settings hold.
function newPage() {
    ReviewsSortPref.resetInstance();
    ReviewsFolds.resetInstance();
    MergedOpenPref.resetInstance();
    resetMigration();
}

async function flush() {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

describe("Reviews sort and folds, as settings (#1758)", () => {
    beforeEach(() => {
        backend.writes = [];
        backend.fail = false;
        vi.stubGlobal("localStorage", memoryStorage());
        publish({});
    });

    afterEach(() => {
        newPage();
        vi.unstubAllGlobals();
    });

    it("sorts by state until the developer chooses", () => {
        expect(globalStore.get(ReviewsSortPref.getInstance().sortAtom)).toBe("state");
    });

    it("keeps the merge order for a new page, and after a restart", async () => {
        ReviewsSortPref.getInstance().set("merge");
        expect(globalStore.get(ReviewsSortPref.getInstance().sortAtom)).toBe("merge");
        await flush();
        expect(backend.writes).toContainEqual({ [ReviewsSortKey]: "merge" });
        newPage();
        expect(globalStore.get(ReviewsSortPref.getInstance().sortAtom)).toBe("merge");
        // A restart: the settings are read again from settings.json, the page's storage is gone.
        const saved = settings();
        globalStore.set(atoms.fullConfigAtom as any, null);
        vi.stubGlobal("localStorage", memoryStorage());
        newPage();
        publish(saved);
        expect(globalStore.get(ReviewsSortPref.getInstance().sortAtom)).toBe("merge");
    });

    it("shows another page's choice live", () => {
        const pref = ReviewsSortPref.getInstance();
        expect(globalStore.get(pref.sortAtom)).toBe("state");
        publish({ [ReviewsSortKey]: "merge" });
        expect(globalStore.get(pref.sortAtom)).toBe("merge");
        publish({ [ReviewsSortKey]: "state" });
        expect(globalStore.get(pref.sortAtom)).toBe("state");
    });

    it("keeps the choice on the page when it cannot be saved", async () => {
        backend.fail = true;
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const pref = ReviewsSortPref.getInstance();
        pref.set("merge");
        await flush();
        expect(globalStore.get(pref.sortAtom)).toBe("merge");
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });

    it("keeps the developer's folds for every view and project", async () => {
        const folds = ReviewsFolds.getInstance();
        folds.set("ready", false);
        MergedOpenPref.getInstance().set(false);
        await flush();
        expect(settings()[ReviewsFoldsKey]).toEqual({ ready: false, merged: false });
        newPage();
        const other = globalStore.get(ReviewsFolds.getInstance().foldsAtom);
        expect(sectionOpen(other, "/another/project", "ready", true)).toBe(false);
        expect(sectionOpen(other, "/p", "agents", true)).toBe(true);
        expect(globalStore.get(MergedOpenPref.getInstance().openAtom)).toBe(false);
    });

    it("opens a section for the page only when the panel shows something in it", async () => {
        publish({ [ReviewsFoldsKey]: { ready: false } });
        const folds = ReviewsFolds.getInstance();
        folds.openForNow("/p", "ready");
        await flush();
        expect(sectionOpen(globalStore.get(folds.foldsAtom), "/p", "ready", true)).toBe(true);
        expect(sectionOpen(globalStore.get(folds.foldsAtom), "/q", "ready", true)).toBe(false);
        expect(backend.writes).toEqual([]);
        // The developer's own fold then wins again, on this page too.
        folds.set("ready", false);
        expect(sectionOpen(globalStore.get(folds.foldsAtom), "/p", "ready", true)).toBe(false);
    });

    it("moves the old localStorage choice into the settings once", async () => {
        const storage = memoryStorage({ [LegacySortStorageKey]: "merge", [LegacyMergedOpenStorageKey]: "closed" });
        vi.stubGlobal("localStorage", storage);
        globalStore.set(atoms.fullConfigAtom as any, null);
        const pref = ReviewsSortPref.getInstance();
        await flush();
        // Not before the settings are read: an unset setting could not be told from one not loaded yet.
        expect(backend.writes).toEqual([]);
        publish({ [ReviewsFoldsKey]: { notes: true } });
        await flush();
        expect(settings()[ReviewsSortKey]).toBe("merge");
        expect(settings()[ReviewsFoldsKey]).toEqual({ notes: true, merged: false });
        expect(globalStore.get(pref.sortAtom)).toBe("merge");
        expect(storage.data.size).toBe(0);
        // Moved once: a new page finds nothing left to move.
        backend.writes = [];
        newPage();
        ReviewsSortPref.getInstance();
        await flush();
        expect(backend.writes).toEqual([]);
    });

    it("never overwrites a setting with the old value", async () => {
        const storage = memoryStorage({ [LegacySortStorageKey]: "state" });
        vi.stubGlobal("localStorage", storage);
        publish({ [ReviewsSortKey]: "merge" });
        await migrateLegacy();
        expect(backend.writes).toEqual([]);
        expect(settings()[ReviewsSortKey]).toBe("merge");
        expect(storage.data.size).toBe(0);
    });

    it("keeps the old value when the move cannot be saved", async () => {
        const storage = memoryStorage({ [LegacySortStorageKey]: "merge" });
        vi.stubGlobal("localStorage", storage);
        backend.fail = true;
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await migrateLegacy();
        expect(storage.data.get(LegacySortStorageKey)).toBe("merge");
        log.mockRestore();
    });
});
