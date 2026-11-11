// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rows of the Features in test page (FR-BOSS-011, #2254): what the registry declares, as this build and the
// developer's switches make it.

import type { BuildChannelName, GateChannel } from "../build/build-channel";
import {
    featureAllowedOn,
    featureOn,
    GatedFeatures,
    type FeaturesNarrowing,
    type GatedFeatureId,
} from "../build/gated-features";

// state: why the feature is as it is; the switch is its own.
export type FeatureState = "on" | "off" | "publicOff" | "closedHere";

export type FeatureRow = {
    id: GatedFeatureId;
    labelKey: string;
    descriptionKey: string;
    channels: BuildChannelName[];
    ticket: number;
    state: FeatureState;
    // The switch shows the feature as it is now.
    on: boolean;
    // Nothing to turn: the channel of this build does not open the feature, or the public version holds every one off.
    locked: boolean;
};

export function featureRows(channel: GateChannel, narrowing: FeaturesNarrowing): FeatureRow[] {
    return GatedFeatures.map((feature) => {
        const on = featureOn(feature.id, channel, narrowing);
        const openHere = featureAllowedOn(feature.id, channel);
        const state: FeatureState = !openHere ? "closedHere" : narrowing.public ? "publicOff" : on ? "on" : "off";
        return {
            id: feature.id,
            labelKey: feature.labelkey,
            descriptionKey: feature.descriptionkey,
            channels: feature.channels,
            ticket: feature.ticket,
            state,
            on,
            locked: !openHere || narrowing.public,
        };
    });
}
