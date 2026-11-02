// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The developer's sort of the Reviews panel (FR-REV-001 AC13, #1061; FR-REV-024 AC-5), by state or by the suggested
// merge order, and the sections they folded or opened: MoltenTerm settings (moltenterm:reviewssort,
// moltenterm:reviewsfolds, #1758), so every view of every window reads the same choice live and keeps it after a
// restart. They lived in localStorage before, which the private app session keeps in memory only: the choice jumped
// back at each restart, and the folds in each new view. That old value is moved into the settings once.

import { atoms, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, Atom, PrimitiveAtom } from "jotai";
import type { ReviewsSort } from "./reviews-sections-model";

export const ReviewsSortKey = "moltenterm:reviewssort";
export const ReviewsFoldsKey = "moltenterm:reviewsfolds";
export const LegacySortStorageKey = "moltenterm:reviews:sort";
export const LegacyMergedOpenStorageKey = "moltenterm:reviews:mergedopen";
export const MergedFold = "merged";

export function sortOf(value: unknown): ReviewsSort {
    return value === "merge" ? "merge" : "state";
}

function savedFolds(): Record<string, boolean> {
    return globalStore.get(getSettingsKeyAtom(ReviewsFoldsKey)) ?? {};
}

// An async function: a write that throws (no backend yet) fails as a promise, whose failure is only logged.
async function writeSettings(settings: SettingsType): Promise<void> {
    await RpcApi.SetConfigCommand(TabRpcClient, settings);
}

function saveSettings(settings: SettingsType) {
    writeSettings(settings).catch((e) => console.log("reviews: could not save the setting", e));
}

function readLegacy(key: string): string {
    try {
        return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

function dropLegacy(keys: string[]) {
    try {
        for (const key of keys) {
            globalThis.localStorage?.removeItem(key);
        }
    } catch {
        // Read again at the next start, and ignored then as the setting is set.
    }
}

// The old values, when the settings do not hold one yet; dropped from localStorage once the settings hold them.
export function migrateLegacy(): Promise<void> {
    const settings = globalStore.get(atoms.settingsAtom) ?? {};
    const update: SettingsType = {};
    const found: string[] = [];
    const sort = readLegacy(LegacySortStorageKey);
    if (sort != null) {
        found.push(LegacySortStorageKey);
        if (settings[ReviewsSortKey] == null) {
            update[ReviewsSortKey] = sortOf(sort);
        }
    }
    const merged = readLegacy(LegacyMergedOpenStorageKey);
    if (merged != null) {
        found.push(LegacyMergedOpenStorageKey);
        const folds = settings[ReviewsFoldsKey] ?? {};
        if (folds[MergedFold] == null) {
            update[ReviewsFoldsKey] = { ...folds, [MergedFold]: merged !== "closed" };
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
        (e) => console.log("reviews: could not move the old choice into the settings", e)
    );
}

let migration: Promise<void> = null;

// Once the settings are loaded: before, an unset setting cannot be told from one not read yet.
function startMigration() {
    if (migration != null) {
        return;
    }
    if (globalStore.get(atoms.fullConfigAtom) != null) {
        migration = migrateLegacy();
        return;
    }
    migration = new Promise<void>((resolve) => {
        const unsub = globalStore.sub(atoms.fullConfigAtom, () => {
            if (globalStore.get(atoms.fullConfigAtom) == null) {
                return;
            }
            unsub();
            migrateLegacy().then(resolve);
        });
    });
}

export function resetMigration() {
    migration = null;
}

export class ReviewsSortPref {
    private static instance: ReviewsSortPref = null;

    sortAtom: PrimitiveAtom<ReviewsSort>;
    unsub: () => void;

    private constructor() {
        const saved = getSettingsKeyAtom(ReviewsSortKey);
        this.sortAtom = atom(sortOf(globalStore.get(saved))) as PrimitiveAtom<ReviewsSort>;
        // Another view's choice, and this one's once saved, arrive with the settings.
        this.unsub = globalStore.sub(saved, () => globalStore.set(this.sortAtom, sortOf(globalStore.get(saved))));
        startMigration();
    }

    static getInstance(): ReviewsSortPref {
        if (ReviewsSortPref.instance == null) {
            ReviewsSortPref.instance = new ReviewsSortPref();
        }
        return ReviewsSortPref.instance;
    }

    static resetInstance(): void {
        ReviewsSortPref.instance?.unsub();
        ReviewsSortPref.instance = null;
    }

    set(sort: ReviewsSort) {
        globalStore.set(this.sortAtom, sort);
        saveSettings({ [ReviewsSortKey]: sort });
    }
}

// session: the sections opened by the panel itself (a card it brings into view, the notes it shows), by project and
// section, for this page only; saved: the developer's own folds, by section, in the settings.
export type Folds = { session: Record<string, boolean>; saved: Record<string, boolean> };

export class ReviewsFolds {
    private static instance: ReviewsFolds = null;

    sessionAtom = atom({}) as PrimitiveAtom<Record<string, boolean>>;
    savedAtom: PrimitiveAtom<Record<string, boolean>>;
    foldsAtom: Atom<Folds>;
    unsub: () => void;

    private constructor() {
        const saved = getSettingsKeyAtom(ReviewsFoldsKey);
        this.savedAtom = atom(savedFolds()) as PrimitiveAtom<Record<string, boolean>>;
        this.foldsAtom = atom((get) => ({ session: get(this.sessionAtom), saved: get(this.savedAtom) }));
        this.unsub = globalStore.sub(saved, () => globalStore.set(this.savedAtom, savedFolds()));
        startMigration();
    }

    static getInstance(): ReviewsFolds {
        if (ReviewsFolds.instance == null) {
            ReviewsFolds.instance = new ReviewsFolds();
        }
        return ReviewsFolds.instance;
    }

    static resetInstance(): void {
        ReviewsFolds.instance?.unsub();
        ReviewsFolds.instance = null;
    }

    // The developer folded or opened a section: every project and every view shows it so, until they change it.
    set(section: string, open: boolean) {
        const session = { ...globalStore.get(this.sessionAtom) };
        for (const key of Object.keys(session)) {
            if (key.endsWith(`\n${section}`)) {
                delete session[key];
            }
        }
        globalStore.set(this.sessionAtom, session);
        const next = { ...globalStore.get(this.savedAtom), [section]: open };
        globalStore.set(this.savedAtom, next);
        saveSettings({ [ReviewsFoldsKey]: next });
    }

    // The panel opens a section to show something: for this page, the developer's saved fold unchanged.
    openForNow(dir: string, section: string) {
        globalStore.set(this.sessionAtom, { ...globalStore.get(this.sessionAtom), [`${dir}\n${section}`]: true });
    }
}

// Whether a section is open: opened by the panel on this page, else the developer's fold, else its default.
export function sectionOpen(folds: Folds, dir: string, section: string, byDefault: boolean): boolean {
    return folds?.session?.[`${dir}\n${section}`] ?? folds?.saved?.[section] ?? byDefault;
}
