// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What earlier versions kept in localStorage (#1763). The app's pages run in the private session
// moltenterm-trusted-app-v1 (emain/authkey.ts, #864), kept in memory: its localStorage is gone at every restart, so a
// preference kept there jumped back. The preferences now live in the settings or in the meta of their object; these
// helpers move an old value over once, and never over one already set.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";

export function readLegacy(key: string): string {
    try {
        return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

export function legacyKeys(prefix: string): string[] {
    try {
        const storage = globalThis.localStorage;
        if (storage == null) {
            return [];
        }
        const rtn: string[] = [];
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (key?.startsWith(prefix)) {
                rtn.push(key);
            }
        }
        return rtn;
    } catch {
        return [];
    }
}

export function dropLegacy(keys: string[]) {
    try {
        for (const key of keys) {
            globalThis.localStorage?.removeItem(key);
        }
    } catch {
        // Read again at the next start, and ignored then as the new place holds a value.
    }
}

// Before the settings are loaded, an unset setting cannot be told from one not read yet.
export function whenSettingsLoaded(): Promise<void> {
    if (globalStore.get(atoms.fullConfigAtom) != null) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        const unsub = globalStore.sub(atoms.fullConfigAtom, () => {
            if (globalStore.get(atoms.fullConfigAtom) == null) {
                return;
            }
            unsub();
            resolve();
        });
    });
}
