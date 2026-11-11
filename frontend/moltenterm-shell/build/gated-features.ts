// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The features that ship gated to the build channel while they are tested, and the developer's switches over them
// (FR-BOSS-011, #2254). One registry declares them: pkg/molten/buildchannel/gated-features.json, which Go embeds too, so
// the window and wavesrv never disagree on what exists where. A gate names its feature with one of the Feature
// constants below; gated-features.test.ts fails on any other.
//
// The switches only narrow: the channel decides first (FR-BOSS-010 AC1), and what the developer stored can only remove
// from what it opens. Pure, with no store: the stored state is read in features-narrowing.ts.

import Registry from "../../../pkg/molten/buildchannel/gated-features.json";
import { isBuildChannelName, type BuildChannelName, type GateChannel } from "./build-channel";

// must match pkg/molten/buildchannel/features.go NarrowingMetaKey
export const FeaturesMetaKey = "molten:featuresintest";

export const FeatureBrainstorm = "brainstorm";

export type GatedFeatureId = typeof FeatureBrainstorm;

export type GatedFeature = {
    id: GatedFeatureId;
    labelkey: string;
    descriptionkey: string;
    channels: BuildChannelName[];
    ticket: number;
};

export const GatedFeatures: readonly GatedFeature[] = Registry.features as GatedFeature[];

export function gatedFeature(id: string): GatedFeature {
    return GatedFeatures.find((f) => f.id === id) ?? null;
}

// The feature is open on this gate channel. A feature outside the registry and a channel that is not known open nothing.
export function featureAllowedOn(id: GatedFeatureId, channel: GateChannel): boolean {
    const feature = gatedFeature(id);
    return feature != null && channel != null && isBuildChannelName(channel) && feature.channels.includes(channel);
}

// Whether the channel opens at least one gated feature: the Features in test entry shows there, and nowhere else.
export function featuresInTestShown(channel: GateChannel): boolean {
    return GatedFeatures.some((f) => featureAllowedOn(f.id, channel));
}

// What the developer switched off on this computer: every gated feature (public, "See the public version"), or the
// ones listed in off.
export type FeaturesNarrowing = { public: boolean; off: string[] };

export const NoNarrowing: FeaturesNarrowing = { public: false, off: [] };

// What is not understood narrows nothing; must read like pkg/molten/buildchannel ParseNarrowing.
export function readNarrowing(raw: unknown): FeaturesNarrowing {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return NoNarrowing;
    }
    const stored = raw as { public?: unknown; off?: unknown };
    const off = Array.isArray(stored.off) ? stored.off.filter((id): id is string => typeof id === "string" && id !== "") : [];
    return { public: stored.public === true, off };
}

export function narrows(narrowing: FeaturesNarrowing, id: string): boolean {
    return narrowing.public || narrowing.off.includes(id);
}

// The whole rule, for a channel and a state. Whatever the state, it never holds where featureAllowedOn does not.
export function featureOn(id: GatedFeatureId, channel: GateChannel, narrowing: FeaturesNarrowing): boolean {
    return featureAllowedOn(id, channel) && !narrows(narrowing, id);
}

// The state after the developer switched one feature off or on; the others, and See the public version, stay as they are.
export function withFeatureOff(narrowing: FeaturesNarrowing, id: string, off: boolean): FeaturesNarrowing {
    const others = narrowing.off.filter((x) => x !== id);
    return { public: narrowing.public, off: off ? [...others, id].sort() : others };
}

export function withPublicVersion(narrowing: FeaturesNarrowing, on: boolean): FeaturesNarrowing {
    return { public: on, off: narrowing.off };
}
