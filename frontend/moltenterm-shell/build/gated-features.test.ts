// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { BuildChannelNames, isBuildChannelName, type GateChannel } from "./build-channel";
import { brainstormAllowed } from "./build-identity";
import * as Gated from "./gated-features";
import {
    FeatureBrainstorm,
    featureAllowedOn,
    featureOn,
    featuresInTestShown,
    FeaturesMetaKey,
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

const States: FeaturesNarrowing[] = [
    NoNarrowing,
    { public: true, off: [] },
    { public: false, off: [FeatureBrainstorm] },
    { public: false, off: ["another"] },
    { public: true, off: [FeatureBrainstorm] },
    { public: false, off: ["", "nope"] },
];

// FR-BOSS-011 AC2: one registry, shared with Go (pkg/molten/buildchannel/gated-features.json).
describe("the registry of gated features", () => {
    it("declares each feature once, with its words in both languages and the channels it is open on", () => {
        expect(GatedFeatures.length).toBeGreaterThan(0);
        expect(new Set(GatedFeatures.map((f) => f.id)).size).toBe(GatedFeatures.length);
        for (const feature of GatedFeatures) {
            expect(feature.ticket, feature.id).toBeGreaterThan(0);
            expect(feature.channels.length, feature.id).toBeGreaterThan(0);
            for (const channel of feature.channels) {
                expect(isBuildChannelName(channel), `${feature.id}: ${channel}`).toBe(true);
            }
            for (const key of [feature.labelkey, feature.descriptionkey]) {
                const english = lookup(en, key);
                const french = lookup(fr, key);
                expect(typeof english, key).toBe("string");
                expect(typeof french, key).toBe("string");
                expect(placeholders(french as string), key).toEqual(placeholders(english as string));
            }
        }
    });

    it("has a Feature constant for each feature, and none for another", () => {
        const constants = Object.entries(Gated)
            .filter(([name, value]) => /^Feature[A-Z]/.test(name) && typeof value === "string")
            .map(([, value]) => value as string);
        expect(constants.sort()).toEqual(GatedFeatures.map((f) => f.id).sort());
    });

    it("is the file Go embeds, and keeps its meta key and its brainstorm id", () => {
        const go = readFileSync("pkg/molten/buildchannel/features.go", "utf8");
        expect(go).toContain(`NarrowingMetaKey = "${FeaturesMetaKey}"`);
        expect(go).toContain(`FeatureBrainstorm = "${FeatureBrainstorm}"`);
        expect(go).toContain("//go:embed gated-features.json");
    });

    it("lists the brainstorm first, on the channels it had before the registry", () => {
        expect(GatedFeatures[0].id).toBe(FeatureBrainstorm);
        expect([...GatedFeatures[0].channels].sort()).toEqual(["dev", "gold", "local"]);
        for (const channel of EveryChannel) {
            expect(brainstormAllowed(channel), String(channel)).toBe(["dev", "gold", "local"].includes(channel));
        }
    });

    it("has the words of the page's states in both languages", () => {
        for (const part of ["on", "off", "publicOff", "closedHere"]) {
            expect(typeof lookup(en, `featuresInTest.state.${part}`), part).toBe("string");
            expect(typeof lookup(fr, `featuresInTest.state.${part}`), part).toBe("string");
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
        expect(featureAllowedOn("nope" as any, "gold")).toBe(false);
        expect(featureOn("nope" as any, "gold", NoNarrowing)).toBe(false);
    });
});

// Must match pkg/molten/buildchannel TestParseNarrowing.
describe("what is stored on the client", () => {
    it.each<[string, unknown, FeaturesNarrowing]>([
        ["nothing stored", undefined, { public: false, off: [] }],
        ["not an object", "brainstorm", { public: false, off: [] }],
        ["a list", ["brainstorm"], { public: false, off: [] }],
        [
            "the stored shape",
            { public: true, off: ["brainstorm"] },
            { public: true, off: ["brainstorm"] },
        ],
        ["a string is not a yes", { public: "true", off: ["brainstorm"] }, { public: false, off: ["brainstorm"] }],
        ["a bad list leaves the other field", { public: true, off: 5 }, { public: true, off: [] }],
        ["only ids count", { off: ["brainstorm", 5, "", null] }, { public: false, off: ["brainstorm"] }],
    ])("reads %s", (_name, raw, want) => {
        expect(readNarrowing(raw)).toEqual(want);
    });

    // FR-BOSS-011 AC4: See the public version leaves each switch as it was.
    it("keeps each switch while the public version is on, and gives them back", () => {
        let state = withFeatureOff(NoNarrowing, FeatureBrainstorm, true);
        state = withPublicVersion(state, true);
        expect(featureOn(FeatureBrainstorm, "gold", state)).toBe(false);
        state = withPublicVersion(state, false);
        expect(state).toEqual({ public: false, off: [FeatureBrainstorm] });
        expect(featureOn(FeatureBrainstorm, "gold", state)).toBe(false);
        state = withFeatureOff(state, FeatureBrainstorm, false);
        expect(featureOn(FeatureBrainstorm, "gold", state)).toBe(true);

        const on = withPublicVersion(NoNarrowing, true);
        expect(featureOn(FeatureBrainstorm, "gold", on)).toBe(false);
        expect(featureOn(FeatureBrainstorm, "gold", withPublicVersion(on, false))).toBe(true);
    });

    it("lists a switched-off feature once, in order", () => {
        const twice = withFeatureOff(withFeatureOff(NoNarrowing, "b", true), "b", true);
        expect(twice.off).toEqual(["b"]);
        expect(withFeatureOff(withFeatureOff(NoNarrowing, "b", true), "a", true).off).toEqual(["a", "b"]);
    });
});

const GateCalls = /(?<![\w.])(featureOn|featureAllowedOn|currentFeatureOn|useFeatureOn)\(\s*([^,)\s]*)/g;
const ImportsAGate = /from "[^"]*\/(gated-features|current-build|use-feature-on)"/;

// The files that implement the gates, or list the registry's own rows, hand on the id they were given.
const HandOn = /^(id|f\.id|feature\.id)$/;
const HandOnFiles = ["build/gated-features.ts", "build/current-build.ts", "library/features-in-test-model.ts"];

// The calls of src that check a gate for something that is not a feature of the registry.
function gateProblems(name: string, src: string, ids: Set<string>, constants: Record<string, string>): string[] {
    const problems: string[] = [];
    const handsOn = HandOnFiles.some((file) => name.endsWith(file));
    for (const match of src.matchAll(GateCalls)) {
        const before = src.slice(Math.max(0, match.index - 12), match.index);
        if (/function\s*$/.test(before)) {
            continue;
        }
        const arg = match[2];
        const literal = /^["'`](.*)["'`]$/.exec(arg);
        const known = literal
            ? ids.has(literal[1])
            : (handsOn && HandOn.test(arg)) || (constants[arg] != null && ids.has(constants[arg]));
        if (!known) {
            problems.push(`${name}: ${match[1]}(${arg}) checks a feature that is not in the registry`);
        }
    }
    return problems;
}

function sources(): string[] {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const found: string[] = [];
    for (const dir of ["frontend", "emain"]) {
        for (const rel of readdirSync(join(root, dir), { recursive: true }) as string[]) {
            if (/\.(ts|tsx)$/.test(rel) && !/\.test\.tsx?$/.test(rel) && !rel.includes("node_modules")) {
                found.push(join(root, dir, rel));
            }
        }
    }
    return found;
}

// FR-BOSS-011 AC2: a gate that checks a feature the registry does not declare fails the tests (pkg/molten/buildchannel
// TestEveryGateNamesARegistryFeature does the same for Go). The guard itself is proved on synthetic sources.
describe("every gate names a feature of the registry", () => {
    const ids = new Set(GatedFeatures.map((f) => f.id as string));
    const constants: Record<string, string> = Object.fromEntries(
        Object.entries(Gated).filter(([name, value]) => /^Feature[A-Z]/.test(name) && typeof value === "string")
    ) as Record<string, string>;

    // Read here, while the file is collected: collection has no timeout, and a loaded machine stretches this CPU-bound
    // scan of every source past a test's 5 s (#2274). The test below only reads the results. Another module may have a
    // function of the same name (browser-popup.ts reads the features of window.open): only the files that import the
    // gates are checked.
    const files = sources();
    let gates = 0;
    const problems = files.flatMap((file) => {
        const src = readFileSync(file, "utf8");
        if (!ImportsAGate.test(src) && !HandOnFiles.some((f) => file.endsWith(f))) {
            return [];
        }
        gates += [...src.matchAll(GateCalls)].length;
        return gateProblems(file, src, ids, constants).map((p) => p.slice(p.indexOf("frontend")));
    });

    it("catches a feature that is not declared, a variable and a constant that does not exist", () => {
        expect(gateProblems("a", `featureOn(FeatureBrainstorm, channel, state)`, ids, constants)).toEqual([]);
        expect(gateProblems("a", `featureAllowedOn("brainstorm", channel)`, ids, constants)).toEqual([]);
        expect(gateProblems("a", `export function featureOn(id: GatedFeatureId, c)`, ids, constants)).toEqual([]);
        expect(gateProblems("a", `x.featureOn("nope")`, ids, constants)).toEqual([]);
        expect(gateProblems("a", `featureOn("nope", c, s)`, ids, constants)).toHaveLength(1);
        expect(gateProblems("a", `currentFeatureOn(FeatureNope)`, ids, constants)).toHaveLength(1);
        expect(gateProblems("a", `useFeatureOn(feature.id)`, ids, constants)).toHaveLength(1);
        expect(gateProblems("a", `featureAllowedOn(id, "gold")`, ids, constants)).toHaveLength(1);
        expect(gateProblems("x/build/gated-features.ts", `featureAllowedOn(id, "gold")`, ids, constants)).toEqual([]);
        expect(gateProblems("x/build/gated-features.ts", `featureAllowedOn("nope", "gold")`, ids, constants)).toHaveLength(1);
    });

    it("holds in every source of the window and of Electron main that imports a gate", () => {
        expect(files.length).toBeGreaterThan(100);
        expect(gates).toBeGreaterThan(0);
        expect(problems).toEqual([]);
    });
});
