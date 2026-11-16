// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { BuildChannelNames, isBuildChannelName, type GateChannel } from "./build-channel";
import * as Gated from "./gated-features";
import {
    featureAllowedOn,
    featureOn,
    featuresInTestShown,
    FeaturesMetaKey,
    gatedFeature,
    GatedFeatures,
    NoNarrowing,
} from "./gated-features";

function lookup(dict: any, key: string): unknown {
    return key.split(".").reduce((node, part) => node?.[part], dict);
}

function placeholders(text: string): string[] {
    return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const EveryChannel: GateChannel[] = [...BuildChannelNames, "unknown", "" as GateChannel, null, "Gold" as GateChannel];

// FR-BOSS-011 AC2: one registry, shared with Go (pkg/molten/buildchannel/gated-features.json). It holds no feature since
// the brainstorm shipped on every channel (#2320): the mechanism it feeds is proved on a sample feature in
// gated-features-mechanism.test.ts.
describe("the registry of gated features", () => {
    it("declares each feature once, with its words in both languages and the channels it is open on", () => {
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

    it("is the file Go embeds, and keeps its meta key", () => {
        const go = readFileSync("pkg/molten/buildchannel/features.go", "utf8");
        expect(go).toContain(`NarrowingMetaKey = "${FeaturesMetaKey}"`);
        expect(go).toContain("//go:embed gated-features.json");
    });

    // FR-BOSS-010 AC1 (#2320): the brainstorm ships on every channel, so no gate, no switch and no row is its own.
    it("does not list the brainstorm: it is open on every channel and has no switch", () => {
        expect(gatedFeature("brainstorm")).toBeNull();
        expect("FeatureBrainstorm" in Gated).toBe(false);
        for (const channel of EveryChannel) {
            expect(featureAllowedOn("brainstorm", channel), String(channel)).toBe(false);
            expect(featureOn("brainstorm", channel, NoNarrowing), String(channel)).toBe(false);
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
    it.each<[GateChannel]>([["rc"], ["public"], ["unknown"], [null], ["" as GateChannel], ["Gold" as GateChannel]])(
        "%s: the entry never shows",
        (channel) => {
            expect(featuresInTestShown(channel)).toBe(false);
        }
    );
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
// TestEveryGateNamesARegistryFeature does the same for Go). The guard itself is proved on synthetic sources, as the
// next gated feature will be declared.
describe("every gate names a feature of the registry", () => {
    const ids = new Set(GatedFeatures.map((f) => f.id as string));
    const constants: Record<string, string> = Object.fromEntries(
        Object.entries(Gated).filter(([name, value]) => /^Feature[A-Z]/.test(name) && typeof value === "string")
    ) as Record<string, string>;
    const sample = { ids: new Set(["sample"]), constants: { FeatureSample: "sample" } };

    // Read here, while the file is collected: collection has no timeout, and a loaded machine stretches this CPU-bound
    // scan of every source past a test's 5 s (#2274). The test below only reads the results. Another module may have a
    // function of the same name (browser-popup.ts reads the features of window.open): only the files that import the
    // gates are checked.
    const files = sources();
    const problems = files.flatMap((file) => {
        const src = readFileSync(file, "utf8");
        if (!ImportsAGate.test(src) && !HandOnFiles.some((f) => file.endsWith(f))) {
            return [];
        }
        return gateProblems(file, src, ids, constants).map((p) => p.slice(p.indexOf("frontend")));
    });

    it("catches a feature that is not declared, a variable and a constant that does not exist", () => {
        const check = (name: string, src: string) => gateProblems(name, src, sample.ids, sample.constants);
        expect(check("a", `featureOn(FeatureSample, channel, state)`)).toEqual([]);
        expect(check("a", `featureAllowedOn("sample", channel)`)).toEqual([]);
        expect(check("a", `export function featureOn(id: GatedFeatureId, c)`)).toEqual([]);
        expect(check("a", `x.featureOn("nope")`)).toEqual([]);
        expect(check("a", `featureOn("nope", c, s)`)).toHaveLength(1);
        expect(check("a", `featureOn("brainstorm", c, s)`)).toHaveLength(1);
        expect(check("a", `currentFeatureOn(FeatureNope)`)).toHaveLength(1);
        expect(check("a", `useFeatureOn(feature.id)`)).toHaveLength(1);
        expect(check("a", `featureAllowedOn(id, "gold")`)).toHaveLength(1);
        expect(check("x/build/gated-features.ts", `featureAllowedOn(id, "gold")`)).toEqual([]);
        expect(check("x/build/gated-features.ts", `featureAllowedOn("nope", "gold")`)).toHaveLength(1);
    });

    it("holds in every source of the window and of Electron main that imports a gate", () => {
        expect(files.length).toBeGreaterThan(100);
        expect(problems).toEqual([]);
    });
});
