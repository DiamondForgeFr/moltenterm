// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    Complexities,
    ComplexityFit,
    EffortRanks,
    modelDisplayName,
    modelFamily,
    ModelTiers,
    proportionHint,
    proportionOf,
} from "./companion-proportion";

describe("model names", () => {
    it("names Claude's model ids by family and version", () => {
        expect(modelDisplayName("claude-opus-5-5")).toBe("Opus 5.5");
        expect(modelDisplayName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
        expect(modelDisplayName("claude-opus-4-20250514")).toBe("Opus 4");
        expect(modelDisplayName("claude-3-5-haiku-20241022")).toBe("Haiku 3.5");
        expect(modelDisplayName("claude-opus-4-6[1m]")).toBe("Opus 4.6");
        expect(modelDisplayName("sonnet")).toBe("Sonnet");
    });

    it("keeps other ids as given and names nothing for an inherited model", () => {
        expect(modelDisplayName("gpt-5-codex")).toBe("gpt-5-codex");
        expect(modelDisplayName("inherit")).toBe("");
        expect(modelDisplayName(undefined)).toBe("");
    });

    it("reads the family from an id or a display name", () => {
        expect(modelFamily("claude-opus-5-5")).toBe("opus");
        expect(modelFamily("Haiku 4.5")).toBe("haiku");
        expect(modelFamily("gpt-5-codex")).toBe("");
    });
});

// AC3: the hint shows for out-of-proportion pairs, both ways, and never otherwise.
describe("proportion table", () => {
    it("flags a low ticket on the largest model at high effort, and a complex one on a small model at low effort", () => {
        expect(proportionOf("claude-opus-5-5", "high", "low")).toBe("over");
        expect(proportionOf("claude-haiku-4-5", "low", "complex")).toBe("under");
    });

    it("matches the documented examples", () => {
        const fits: [string, string, string][] = [
            ["sonnet", "high", "bug"],
            ["opus", "high", "bug"],
            ["haiku", "high", "low"],
            ["opus", "medium", "low"],
            ["sonnet", "low", "medium"],
            ["opus", "xhigh", "medium"],
            ["sonnet", "high", "complex"],
            ["opus", "medium", "complex"],
        ];
        for (const [model, effort, complexity] of fits) {
            expect(proportionOf(model, effort, complexity), `${model} ${effort} ${complexity}`).toBeNull();
        }
        expect(proportionOf("opus", "xhigh", "bug")).toBe("over");
        expect(proportionOf("opus", "max", "medium")).toBe("over");
        expect(proportionOf("haiku", "low", "medium")).toBe("under");
        expect(proportionOf("opus", "low", "complex")).toBe("under");
        expect(proportionOf("sonnet", "medium", "complex")).toBe("under");
    });

    it("gives a hint exactly outside each complexity's range, for every pair of the tables", () => {
        for (const complexity of Complexities) {
            const fit = ComplexityFit[complexity];
            for (const [family, tier] of Object.entries(ModelTiers)) {
                for (const [effort, rank] of Object.entries(EffortRanks)) {
                    const power = tier + rank;
                    const want = power > fit.max ? "over" : power < fit.min ? "under" : null;
                    expect(proportionOf(family, effort, complexity), `${family} ${effort} ${complexity}`).toBe(want);
                }
            }
        }
    });

    it("keeps the ranges ordered, so a stronger ticket never fits a weaker agent better", () => {
        expect(ComplexityFit.low.min).toBeLessThanOrEqual(ComplexityFit.medium.min);
        expect(ComplexityFit.medium.min).toBeLessThanOrEqual(ComplexityFit.complex.min);
        expect(ComplexityFit.low.max).toBeLessThanOrEqual(ComplexityFit.medium.max);
        expect(ComplexityFit.medium.max).toBeLessThanOrEqual(ComplexityFit.complex.max);
    });

    it("gives no hint when anything is unknown", () => {
        expect(proportionOf("gpt-5-codex", "high", "low")).toBeNull();
        expect(proportionOf("claude-opus-5-5", "", "low")).toBeNull();
        expect(proportionOf("claude-opus-5-5", "turbo", "low")).toBeNull();
        expect(proportionOf("claude-opus-5-5", "max", "")).toBeNull();
        expect(proportionOf("claude-opus-5-5", "max", "huge")).toBeNull();
    });

    it("words the hint calmly, with the reason in its title", () => {
        expect(proportionHint("claude-opus-5-5", "high", "low")).toEqual({
            kind: "over",
            label: "More than a low ticket needs",
            title: "Opus 5.5 at high effort is more than a low-complexity ticket needs: a smaller model or a lower effort may do.",
        });
        expect(proportionHint("haiku", "low", "complex")?.label).toBe("Less than a complex ticket needs");
        expect(proportionHint("opus", "medium", "medium")).toBeNull();
    });
});
