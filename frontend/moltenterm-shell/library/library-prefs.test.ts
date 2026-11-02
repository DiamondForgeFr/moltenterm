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
import { lastSettingsTab } from "./library-model";
import {
    LegacyMaterialsSeenPrefix,
    LegacySettingsTabStorageKey,
    LibraryPrefs,
    MaterialsSeenKey,
    MaxSeenProjects,
    migrateLegacy,
    resetMigration,
    SettingsTabKey,
} from "./library-prefs";

const Blocks = ["general", "keyboard", "agents"] as const;

function settings(): Record<string, unknown> {
    return (globalStore.get(atoms.fullConfigAtom) as any)?.settings ?? {};
}

function publish(next: Record<string, unknown>) {
    globalStore.set(atoms.fullConfigAtom as any, { settings: next });
}

function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        get length() {
            return data.size;
        },
        key: (i: number) => [...data.keys()][i] ?? null,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
        data,
    };
}

// A new page: its own instance, which only knows what the settings hold.
function newPage(): LibraryPrefs {
    LibraryPrefs.resetInstance();
    resetMigration();
    return LibraryPrefs.getInstance();
}

function tab(prefs: LibraryPrefs): string {
    return lastSettingsTab(globalStore.get(prefs.settingsTabAtom), Blocks);
}

async function flush() {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

// A restart: the settings are read again from settings.json, the page's storage is gone.
function restart(): LibraryPrefs {
    const saved = settings();
    globalStore.set(atoms.fullConfigAtom as any, null);
    vi.stubGlobal("localStorage", memoryStorage());
    const prefs = newPage();
    publish(saved);
    return prefs;
}

describe("the library's Settings tab and seen materials, as settings (#1763)", () => {
    beforeEach(() => {
        backend.writes = [];
        backend.fail = false;
        vi.stubGlobal("localStorage", memoryStorage());
        publish({});
    });

    afterEach(() => {
        LibraryPrefs.resetInstance();
        resetMigration();
        vi.unstubAllGlobals();
    });

    it("keeps the Settings tab for a new page, and after a restart", async () => {
        expect(tab(newPage())).toBeNull();
        newPage().setSettingsTab("keyboard");
        await flush();
        expect(backend.writes).toContainEqual({ [SettingsTabKey]: "keyboard" });
        expect(tab(newPage())).toBe("keyboard");
        expect(tab(restart())).toBe("keyboard");
        // Overview is saved too: a later start does not fall back to the older block.
        LibraryPrefs.getInstance().setSettingsTab(null);
        await flush();
        expect(tab(restart())).toBeNull();
    });

    it("keeps when materials were seen, per project, for a new page and after a restart", async () => {
        const prefs = newPage();
        prefs.markSeen("p1", 1000, true);
        prefs.markSeen("p2", 2000, true);
        await flush();
        expect(newPage().seenAt("p1")).toBe(1000);
        const restarted = restart();
        expect(restarted.seenAt("p1")).toBe(1000);
        expect(restarted.seenAt("p2")).toBe(2000);
        expect(restarted.seenAt("p3")).toBe(0);
    });

    it("writes the seen time only when it changes what is new", async () => {
        const prefs = newPage();
        prefs.markSeen("p1", 1000, false);
        await flush();
        expect(backend.writes).toHaveLength(1);
        prefs.markSeen("p1", 2000, false);
        await flush();
        expect(backend.writes).toHaveLength(1);
        expect(prefs.seenAt("p1")).toBe(1000);
        prefs.markSeen("p1", 3000, true);
        await flush();
        expect(prefs.seenAt("p1")).toBe(3000);
    });

    it("keeps the latest projects only", async () => {
        const prefs = newPage();
        for (let i = 1; i <= MaxSeenProjects + 5; i++) {
            prefs.markSeen(`p${i}`, i, true);
        }
        await flush();
        const saved = settings()[MaterialsSeenKey] as Record<string, number>;
        expect(Object.keys(saved)).toHaveLength(MaxSeenProjects);
        expect(saved.p1).toBeUndefined();
        expect(saved[`p${MaxSeenProjects + 5}`]).toBe(MaxSeenProjects + 5);
    });

    it("shows another page's change live", () => {
        const prefs = newPage();
        publish({ [SettingsTabKey]: "agents", [MaterialsSeenKey]: { p1: 5000 } });
        expect(tab(prefs)).toBe("agents");
        expect(prefs.seenAt("p1")).toBe(5000);
        publish({ [SettingsTabKey]: "general", [MaterialsSeenKey]: { p1: 6000 } });
        expect(tab(prefs)).toBe("general");
        expect(prefs.seenAt("p1")).toBe(6000);
    });

    it("keeps the change on the page when it cannot be saved", async () => {
        backend.fail = true;
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const prefs = newPage();
        prefs.setSettingsTab("agents");
        prefs.markSeen("p1", 1000, true);
        await flush();
        expect(tab(prefs)).toBe("agents");
        expect(prefs.seenAt("p1")).toBe(1000);
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });

    it("moves the old localStorage values into the settings once, after the settings load", async () => {
        const storage = memoryStorage({
            [LegacySettingsTabStorageKey]: "keyboard",
            [`${LegacyMaterialsSeenPrefix}p1`]: "1000",
            [`${LegacyMaterialsSeenPrefix}p2`]: "2000",
            unrelated: "kept",
        });
        vi.stubGlobal("localStorage", storage);
        globalStore.set(atoms.fullConfigAtom as any, null);
        const prefs = newPage();
        await flush();
        // Not before the settings are read: an unset setting could not be told from one not loaded yet.
        expect(backend.writes).toEqual([]);
        publish({ [MaterialsSeenKey]: { p2: 9000 } });
        await flush();
        expect(tab(prefs)).toBe("keyboard");
        expect(prefs.seenAt("p1")).toBe(1000);
        expect(prefs.seenAt("p2")).toBe(9000);
        expect([...storage.data.keys()]).toEqual(["unrelated"]);
        backend.writes = [];
        newPage();
        await flush();
        expect(backend.writes).toEqual([]);
    });

    it("never overwrites a setting with the old value", async () => {
        const storage = memoryStorage({
            [LegacySettingsTabStorageKey]: "general",
            [`${LegacyMaterialsSeenPrefix}p1`]: "1",
        });
        vi.stubGlobal("localStorage", storage);
        publish({ [SettingsTabKey]: "agents", [MaterialsSeenKey]: { p1: 5000 } });
        await migrateLegacy();
        expect(backend.writes).toEqual([]);
        expect(settings()[SettingsTabKey]).toBe("agents");
        expect(settings()[MaterialsSeenKey]).toEqual({ p1: 5000 });
        expect(storage.data.size).toBe(0);
    });

    it("keeps the old values when they cannot be moved", async () => {
        backend.fail = true;
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const storage = memoryStorage({ [LegacySettingsTabStorageKey]: "general" });
        vi.stubGlobal("localStorage", storage);
        await migrateLegacy();
        expect(storage.data.get(LegacySettingsTabStorageKey)).toBe("general");
        log.mockRestore();
    });
});
