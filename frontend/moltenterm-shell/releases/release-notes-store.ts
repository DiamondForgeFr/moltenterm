// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Who opens the version history (FR-REL-004): the status bar's build badge, About, and later the update notification
// (#188), which opens it on the version it offers and sets offeredVersionAtom.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";

export class ReleaseNotesModel {
    private static instance: ReleaseNotesModel = null;

    openAtom = atom(false) as PrimitiveAtom<boolean>;
    // The version to select when the window opens; null selects This build, else the installed version.
    requestedVersionAtom = atom(null) as PrimitiveAtom<string>;
    // An update for this build's channel, waiting to be installed (#188): its version and its notes.
    offeredAtom = atom(null) as PrimitiveAtom<{ version: string; notes: string }>;

    private constructor() {}

    static getInstance(): ReleaseNotesModel {
        if (!ReleaseNotesModel.instance) {
            ReleaseNotesModel.instance = new ReleaseNotesModel();
        }
        return ReleaseNotesModel.instance;
    }

    open(version?: string) {
        globalStore.set(this.requestedVersionAtom, version ?? null);
        globalStore.set(this.openAtom, true);
    }

    close() {
        globalStore.set(this.openAtom, false);
    }
}
