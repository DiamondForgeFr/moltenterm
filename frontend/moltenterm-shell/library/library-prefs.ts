// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The library's own memory (#1763): the Settings tab it reopens on (#1592) and when each project's materials were last
// seen (the section's new count, AC12). MoltenTerm settings (moltenterm:settingstab, moltenterm:materialsseen), hidden in the
// Settings screen as the tabs and the materials section set them, so every view reads them live and keeps them after
// a restart. They lived in the in-memory session's localStorage before (legacy-storage.ts).

import { atoms, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { dropLegacy, legacyKeys, readLegacy, whenSettingsLoaded } from "../legacy-storage";
import { SettingsOverviewTab } from "./library-model";

export const SettingsTabKey = "moltenterm:settingstab";
export const MaterialsSeenKey = "moltenterm:materialsseen";
export const LegacySettingsTabStorageKey = "moltenterm:library-settings-tab";
export const LegacyMaterialsSeenPrefix = "molten:materials:seen:";
// Projects come and go: the latest seen are kept, so the setting does not grow for ever.
export const MaxSeenProjects = 100;

type Seen = Record<string, number>;

function readSeen(raw: unknown): Seen {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const rtn: Seen = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) {
            rtn[k] = v;
        }
    }
    return rtn;
}

function keepLatest(seen: Seen): Seen {
    const entries = Object.entries(seen);
    if (entries.length <= MaxSeenProjects) {
        return seen;
    }
    entries.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(entries.slice(0, MaxSeenProjects));
}

// An async function: a write that throws (no backend yet) fails as a promise, whose failure is only logged.
async function writeSettings(settings: SettingsType): Promise<void> {
    await RpcApi.SetConfigCommand(TabRpcClient, settings);
}

function saveSettings(settings: SettingsType) {
    writeSettings(settings).catch((e) => console.log("library: could not save the setting", e));
}

// The old values, where the settings hold none yet; dropped from localStorage once the settings hold them.
export function migrateLegacy(): Promise<void> {
    const settings = globalStore.get(atoms.settingsAtom) ?? {};
    const update: SettingsType = {};
    const found: string[] = [];
    const tab = readLegacy(LegacySettingsTabStorageKey);
    if (tab != null) {
        found.push(LegacySettingsTabStorageKey);
        if (settings[SettingsTabKey] == null && tab !== "") {
            update[SettingsTabKey] = tab;
        }
    }
    const seenKeys = legacyKeys(LegacyMaterialsSeenPrefix);
    if (seenKeys.length > 0) {
        found.push(...seenKeys);
        const saved = readSeen(settings[MaterialsSeenKey]);
        const merged = { ...saved };
        for (const key of seenKeys) {
            const project = key.slice(LegacyMaterialsSeenPrefix.length);
            const at = Math.round(Number(readLegacy(key)));
            if (merged[project] == null && Number.isFinite(at) && at > 0) {
                merged[project] = at;
            }
        }
        if (Object.keys(merged).length > Object.keys(saved).length) {
            update[MaterialsSeenKey] = keepLatest(merged);
        }
    }
    if (found.length === 0) {
        return Promise.resolve();
    }
    if (Object.keys(update).length === 0) {
        dropLegacy(found);
        return Promise.resolve();
    }
    return writeSettings(update).then(
        () => dropLegacy(found),
        (e) => console.log("library: could not move the old values into the settings", e)
    );
}

let migration: Promise<void> = null;

function startMigration() {
    if (migration == null) {
        migration = whenSettingsLoaded().then(migrateLegacy);
    }
}

export function resetMigration() {
    migration = null;
}

export class LibraryPrefs {
    private static instance: LibraryPrefs = null;

    // The block Settings reopens on; null is Overview.
    settingsTabAtom: PrimitiveAtom<string>;
    seenAtom: PrimitiveAtom<Seen>;
    unsubs: (() => void)[] = [];

    private constructor() {
        const tab = getSettingsKeyAtom(SettingsTabKey);
        const seen = getSettingsKeyAtom(MaterialsSeenKey);
        this.settingsTabAtom = atom(globalStore.get(tab) ?? null) as PrimitiveAtom<string>;
        this.seenAtom = atom(readSeen(globalStore.get(seen))) as PrimitiveAtom<Seen>;
        // Another view's choice, and this one's once saved, arrive with the settings.
        this.unsubs.push(
            globalStore.sub(tab, () => globalStore.set(this.settingsTabAtom, globalStore.get(tab) ?? null))
        );
        this.unsubs.push(globalStore.sub(seen, () => globalStore.set(this.seenAtom, readSeen(globalStore.get(seen)))));
        startMigration();
    }

    static getInstance(): LibraryPrefs {
        if (LibraryPrefs.instance == null) {
            LibraryPrefs.instance = new LibraryPrefs();
        }
        return LibraryPrefs.instance;
    }

    static resetInstance(): void {
        LibraryPrefs.instance?.unsubs.forEach((u) => u());
        LibraryPrefs.instance = null;
    }

    // null is Overview, saved as such so a later start does not fall back to an older block.
    setSettingsTab(block: string) {
        const value = block ?? SettingsOverviewTab;
        if (globalStore.get(this.settingsTabAtom) === value) {
            return;
        }
        globalStore.set(this.settingsTabAtom, value);
        saveSettings({ [SettingsTabKey]: value });
    }

    seenAt(project: string): number {
        return globalStore.get(this.seenAtom)[project ?? ""] ?? 0;
    }

    // Only when it changes what is new: an open section is marked at each change of the drawer.
    markSeen(project: string, at: number, hasNew: boolean) {
        const key = project ?? "";
        if (!hasNew && this.seenAt(key) > 0) {
            return;
        }
        const next = keepLatest({ ...globalStore.get(this.seenAtom), [key]: Math.round(at) });
        globalStore.set(this.seenAtom, next);
        saveSettings({ [MaterialsSeenKey]: next });
    }
}
