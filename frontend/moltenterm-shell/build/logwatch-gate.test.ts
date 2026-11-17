// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

// A registry that lists rc and public for the log watch by mistake: the internal-only lock still keeps it off a release
// (FR-BOSS-012 AC1, #2336), as pkg/molten/buildchannel TestTheLogWatchNeverOpensOnAReleaseWhateverTheRegistrySays does.
vi.mock("../../../pkg/molten/buildchannel/gated-features.json", () => ({
    default: {
        features: [
            {
                id: "logwatch",
                labelkey: "featuresInTest.features.logwatch.label",
                descriptionkey: "featuresInTest.features.logwatch.description",
                channels: ["dev", "local", "gold", "rc", "public"],
                ticket: 2336,
            },
        ],
    },
}));

import type { GateChannel } from "./build-channel";
import { featureAllowedOn, FeatureLogWatch, logWatchOn, NoNarrowing } from "./gated-features";

describe("the log watch's internal-only lock", () => {
    it.each<[GateChannel]>([["rc"], ["public"], ["unknown"], [null], ["" as GateChannel]])(
        "%s: closed, whatever the registry says",
        (channel) => {
            expect(featureAllowedOn(FeatureLogWatch, "rc")).toBe(true);
            expect(logWatchOn(channel, NoNarrowing)).toBe(false);
        }
    );

    it.each<[GateChannel]>([["gold"], ["dev"], ["local"]])("%s: open", (channel) => {
        expect(logWatchOn(channel, NoNarrowing)).toBe(true);
    });
});
