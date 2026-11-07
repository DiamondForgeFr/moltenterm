// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";

// The questions a browser panel's pages ask the user (site permissions, client certificates), per browser tab, oldest
// first; in memory only. Each bar's model adds how it answers.
export class TabAsks<T extends { requestid: string }> {
    asksAtom = atom({}) as PrimitiveAtom<Record<string, T[]>>;

    add(tabId: string, ask: T): void {
        const all = globalStore.get(this.asksAtom);
        const list = all[tabId] ?? [];
        if (list.some((a) => a.requestid === ask.requestid)) {
            return;
        }
        globalStore.set(this.asksAtom, { ...all, [tabId]: [...list, ask] });
    }

    // The question is gone: answered here, or settled by main (another answer, the timeout, the page closed).
    remove(requestId: string): void {
        const all = globalStore.get(this.asksAtom);
        let changed = false;
        const next: Record<string, T[]> = {};
        for (const [tabId, list] of Object.entries(all)) {
            const kept = list.filter((a) => a.requestid !== requestId);
            changed = changed || kept.length !== list.length;
            if (kept.length > 0) {
                next[tabId] = kept;
            }
        }
        if (changed) {
            globalStore.set(this.asksAtom, next);
        }
    }

    current(tabId: string): T {
        return globalStore.get(this.asksAtom)[tabId]?.[0] ?? null;
    }

    asksOf(tabId: string): T[] {
        return globalStore.get(this.asksAtom)[tabId] ?? [];
    }
}
