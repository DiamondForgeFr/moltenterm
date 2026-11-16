// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the Features in test page does with a switch (FR-BOSS-011, #2254). A feature that is running is ended before its
// switch closes it, so what it held (a pause, a slid sidebar) is let go and nothing is lost; then the switch is written
// to the client's meta, where every window and wavesrv read it.

import { narrowingToChange, writeNarrowing } from "./features-narrowing";
import { GatedFeatures, withFeatureOff, withPublicVersion, type GatedFeatureId } from "./gated-features";

// What a feature that is running does when its switch is about to close it: a feature that holds something while it runs
// adds its entry here, by id. None does since the brainstorm shipped on every channel (#2320).
export const EndBeforeOff: Record<GatedFeatureId, () => Promise<void>> = {};

// A feature that cannot be ended is switched off all the same: the developer's switch is not held back by it.
async function endOne(id: GatedFeatureId): Promise<void> {
    try {
        await EndBeforeOff[id]?.();
    } catch (e) {
        console.log("features in test: a feature could not be ended first", id, e);
    }
}

async function endRunning(ids: readonly GatedFeatureId[]): Promise<void> {
    await Promise.all(ids.map(endOne));
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
