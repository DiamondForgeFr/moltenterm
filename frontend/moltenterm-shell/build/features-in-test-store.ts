// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the Features in test page does with a switch (FR-BOSS-011, #2254). A feature that is running is ended before its
// switch closes it, so what it held (the pause on notifications, the slid sidebar) is let go and nothing is lost; then
// the switch is written to the client's meta, where every window and wavesrv read it.

import { globalStore } from "@/app/store/jotaiStore";
import { BrainstormStateAtom, loadBrainstorm } from "../brainstorm/brainstorm-boot";
import { narrowingToChange, writeNarrowing } from "./features-narrowing";
import { FeatureBrainstorm, GatedFeatures, withFeatureOff, withPublicVersion, type GatedFeatureId } from "./gated-features";

async function endTheBrainstorm(): Promise<void> {
    if (globalStore.get(BrainstormStateAtom)?.open !== true) {
        return;
    }
    try {
        const mod = await loadBrainstorm();
        await mod.BrainstormModel.getInstance().end();
    } catch (e) {
        console.log("features in test: the brainstorm could not be ended first", e);
    }
}

// What a feature that is running does when its switch is about to close it.
const EndBeforeOff: Record<GatedFeatureId, () => Promise<void>> = {
    [FeatureBrainstorm]: endTheBrainstorm,
};

async function endRunning(ids: readonly GatedFeatureId[]): Promise<void> {
    await Promise.all(ids.map((id) => EndBeforeOff[id]?.()));
}

export async function switchFeature(id: GatedFeatureId, off: boolean): Promise<void> {
    if (off) {
        await endRunning([id]);
    }
    await writeNarrowing(withFeatureOff(narrowingToChange(), id, off));
}

export async function switchPublicVersion(on: boolean): Promise<void> {
    if (on) {
        await endRunning(GatedFeatures.map((f) => f.id));
    }
    await writeNarrowing(withPublicVersion(narrowingToChange(), on));
}
