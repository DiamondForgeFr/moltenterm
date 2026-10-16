// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The developer's choice of order for the Reviews list (FR-REV-024 AC-5): the suggested merge order or the list's own,
// remembered on this computer and shared by its windows. Storage may be unavailable: the suggested order applies then.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";

export type MergeOrderChoice = "suggested" | "list";

export const MergeOrderStorageKey = "moltenterm:reviews:mergeorder";

function readChoice(): MergeOrderChoice {
    try {
        return globalThis.localStorage?.getItem(MergeOrderStorageKey) === "list" ? "list" : "suggested";
    } catch {
        return "suggested";
    }
}

export class MergeOrderPref {
    private static instance: MergeOrderPref = null;

    choiceAtom = atom(readChoice()) as PrimitiveAtom<MergeOrderChoice>;

    private constructor() {
        globalThis.addEventListener?.("storage", (e: StorageEvent) => {
            if (e.key === MergeOrderStorageKey) {
                globalStore.set(this.choiceAtom, readChoice());
            }
        });
    }

    static getInstance(): MergeOrderPref {
        if (MergeOrderPref.instance == null) {
            MergeOrderPref.instance = new MergeOrderPref();
        }
        return MergeOrderPref.instance;
    }

    static resetInstance(): void {
        MergeOrderPref.instance = null;
    }

    set(choice: MergeOrderChoice) {
        globalStore.set(this.choiceAtom, choice);
        try {
            globalThis.localStorage?.setItem(MergeOrderStorageKey, choice);
        } catch {
            // The choice still holds for this session.
        }
    }
}
