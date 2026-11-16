// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

// The registry holds no feature since the brainstorm shipped on every channel (#2320). The mechanism that stays for the
// next gated feature is proved on a sample one: gold, dev and local builds, with words that exist in both languages.
vi.mock("../../../pkg/molten/buildchannel/gated-features.json", () => ({
    default: {
        features: [
            {
                id: "sample",
                labelkey: "boss.brainstorm.menu",
                descriptionkey: "boss.brainstorm.opening",
                channels: ["dev", "local", "gold"],
                ticket: 1,
            },
        ],
    },
}));

import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { librarySectionAt, visibleLibrarySections } from "../library/library-model";
import { BuildChannelNames, isBuildChannelName, type GateChannel } from "./build-channel";
import {
    featureAllowedOn,
    featureOn,
    featuresInTestShown,
    GatedFeatures,
    narrows,
    NoNarrowing,
    readNarrowing,
    withFeatureOff,
    withPublicVersion,
    type FeaturesNarrowing,
} from "./gated-features";

function lookup(dict: any, key: string): unknown {
    return key.split(".").reduce((node, part) => node?.[part], dict);
}

function placeholders(text: string): string[] {
    return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const EveryChannel: GateChannel[] = [...BuildChannelNames, "unknown", "" as GateChannel, null, "Gold" as GateChannel];
const Sample = "sample";

const States: FeaturesNarrowing[] = [
    NoNarrowing,
    { public: true, off: [] },
    { public: false, off: [Sample] },
    { public: false, off: ["another"] },
    { public: true, off: [Sample] },
    { public: false, off: ["", "nope"] },
];

describe("the registry, with a feature in it", () => {
    it("declares the feature with its words in both languages and the channels it is open on", () => {
        expect(GatedFeatures.map((f) => f.id)).toEqual([Sample]);
        const [feature] = GatedFeatures;
        expect(feature.ticket).toBeGreaterThan(0);
        for (const channel of feature.channels) {
            expect(isBuildChannelName(channel), channel).toBe(true);
        }
        for (const key of [feature.labelkey, feature.descriptionkey]) {
            const english = lookup(en, key);
            expect(typeof english, key).toBe("string");
            expect(typeof lookup(fr, key), key).toBe("string");
            expect(placeholders(lookup(fr, key) as string), key).toEqual(placeholders(english as string));
        }
    });
});

describe("which channels have a feature in test", () => {
    it.each<[GateChannel, boolean]>([
        ["dev", true],
        ["local", true],
        ["gold", true],
        ["rc", false],
        ["public", false],
        ["unknown", false],
        [null, false],
    ])("%s: the entry shows %s", (channel, shown) => {
        expect(featuresInTestShown(channel)).toBe(shown);
    });

    // FR-BOSS-011 AC1: the entry of the library's navigation follows, and the switches do not hide it (it takes no
    // state), so the page stays there to turn a feature back on.
    it("puts Features in test in the library's navigation on those channels only", () => {
        for (const channel of EveryChannel) {
            const shown = visibleLibrarySections(channel).some((s) => s.id === "features");
            expect(shown, String(channel)).toBe(["dev", "local", "gold"].includes(channel));
        }
        const gold = visibleLibrarySections("gold");
        expect(librarySectionAt("agents", -1, gold)).toBe("features");
        expect(librarySectionAt("settings", 1, gold)).toBe("features");
        expect(librarySectionAt("features", 1, gold)).toBe("agents");
    });
});

// FR-BOSS-011 AC5. Must match pkg/molten/buildchannel TestASwitchOnlyNarrows.
describe("a switch only narrows", () => {
    it("never opens a feature its channel does not open, whatever is stored", () => {
        for (const feature of GatedFeatures) {
            for (const channel of EveryChannel) {
                for (const state of States) {
                    const on = featureOn(feature.id, channel, state);
                    const allowed = featureAllowedOn(feature.id, channel);
                    const label = `${feature.id} on ${channel} with ${JSON.stringify(state)}`;
                    if (!allowed) {
                        expect(on, label).toBe(false);
                    }
                    if (narrows(state, feature.id)) {
                        expect(on, label).toBe(false);
                    }
                    if (allowed && !narrows(state, feature.id)) {
                        expect(on, label).toBe(true);
                    }
                    if (channel === "rc" || channel === "public") {
                        expect(on, label).toBe(false);
                    }
                }
            }
        }
    });

    it("opens nothing for a feature outside the registry", () => {
        expect(featureAllowedOn("nope", "gold")).toBe(false);
        expect(featureOn("nope", "gold", NoNarrowing)).toBe(false);
        expect(featureAllowedOn("brainstorm", "gold")).toBe(false);
    });
});

// Must match pkg/molten/buildchannel TestParseNarrowing.
describe("what is stored on the client", () => {
    it.each<[string, unknown, FeaturesNarrowing]>([
        ["nothing stored", undefined, { public: false, off: [] }],
        ["not an object", Sample, { public: false, off: [] }],
        ["a list", [Sample], { public: false, off: [] }],
        ["the stored shape", { public: true, off: [Sample] }, { public: true, off: [Sample] }],
        ["a string is not a yes", { public: "true", off: [Sample] }, { public: false, off: [Sample] }],
        ["a bad list leaves the other field", { public: true, off: 5 }, { public: true, off: [] }],
        ["only ids count", { off: [Sample, 5, "", null] }, { public: false, off: [Sample] }],
    ])("reads %s", (_name, raw, want) => {
        expect(readNarrowing(raw)).toEqual(want);
    });

    // FR-BOSS-011 AC4: See the public version leaves each switch as it was.
    it("keeps each switch while the public version is on, and gives them back", () => {
        let state = withFeatureOff(NoNarrowing, Sample, true);
        state = withPublicVersion(state, true);
        expect(featureOn(Sample, "gold", state)).toBe(false);
        state = withPublicVersion(state, false);
        expect(state).toEqual({ public: false, off: [Sample] });
        expect(featureOn(Sample, "gold", state)).toBe(false);
        state = withFeatureOff(state, Sample, false);
        expect(featureOn(Sample, "gold", state)).toBe(true);

        const on = withPublicVersion(NoNarrowing, true);
        expect(featureOn(Sample, "gold", on)).toBe(false);
        expect(featureOn(Sample, "gold", withPublicVersion(on, false))).toBe(true);
    });

    it("lists a switched-off feature once, in order", () => {
        const twice = withFeatureOff(withFeatureOff(NoNarrowing, "b", true), "b", true);
        expect(twice.off).toEqual(["b"]);
        expect(withFeatureOff(withFeatureOff(NoNarrowing, "b", true), "a", true).off).toEqual(["a", "b"]);
    });
});
