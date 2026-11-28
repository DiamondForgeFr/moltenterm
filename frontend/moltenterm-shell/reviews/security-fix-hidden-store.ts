// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the developer hid from the security fix block, for as long as the window lives (FR-REV-036 AC17): the ask he put
// off ("Later") and what a merge unblocked once he read it ("Hide"). Nothing is lost: the pull requests the block holds
// say on their card that the alert is above, and "See the alert" brings it back.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useMemo } from "react";
import type { SecurityFixHidden } from "./security-fix-panel-model";

function keyOf(dir: string, key: string): string {
    return `${dir}\n${key}`;
}

export class SecurityFixHiddenStore {
    private static instance: SecurityFixHiddenStore = null;

    laterAtom = atom<readonly string[]>([]) as PrimitiveAtom<readonly string[]>;
    dismissedAtom = atom<readonly string[]>([]) as PrimitiveAtom<readonly string[]>;

    private constructor() {}

    static getInstance(): SecurityFixHiddenStore {
        if (SecurityFixHiddenStore.instance == null) {
            SecurityFixHiddenStore.instance = new SecurityFixHiddenStore();
        }
        return SecurityFixHiddenStore.instance;
    }

    static resetInstance(): void {
        SecurityFixHiddenStore.instance = null;
    }

    // The ask is put off: the block leaves until the window is opened again, or the developer asks to see the alert.
    later(dir: string, key: string) {
        globalStore.set(this.laterAtom, [...globalStore.get(this.laterAtom), keyOf(dir, key)]);
    }

    // "See the alert": the block is back.
    show(dir: string, key: string) {
        const hidden = keyOf(dir, key);
        globalStore.set(
            this.laterAtom,
            globalStore.get(this.laterAtom).filter((k) => k !== hidden)
        );
    }

    // What a merged fix unblocked is read: its block goes, whatever a later read of the answer says of that fix.
    dismiss(dir: string, key: string) {
        globalStore.set(this.dismissedAtom, [...globalStore.get(this.dismissedAtom), keyOf(dir, key)]);
    }
}

// The project's hidden blocks, read the way the panel's model asks.
export function useSecurityFixHidden(dir: string): SecurityFixHidden {
    const later = useAtomValue(SecurityFixHiddenStore.getInstance().laterAtom);
    const dismissed = useAtomValue(SecurityFixHiddenStore.getInstance().dismissedAtom);
    return useMemo(
        () => ({
            later: (key: string) => later.includes(keyOf(dir, key)),
            dismissed: (key: string) => dismissed.includes(keyOf(dir, key)),
        }),
        [dir, later, dismissed]
    );
}
