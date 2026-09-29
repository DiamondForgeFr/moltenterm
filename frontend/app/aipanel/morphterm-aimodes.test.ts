// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { firstUserAIMode, isUserAIMode } from "@/app/aipanel/morphterm-aimodes";
import { describe, expect, it } from "vitest";

describe("Morphterm AI modes", () => {
    it("treats waveai@ modes as Wave's, everything else as the user's", () => {
        expect(isUserAIMode("waveai@balanced")).toBe(false);
        expect(isUserAIMode("ollama@llama")).toBe(true);
    });

    it("picks the user's first mode by display:order, then by name", () => {
        const configs = {
            "waveai@balanced": { "display:order": -2 },
            "zeta@local": { "display:order": 1 },
            "beta@openai": { "display:order": 0 },
            "alpha@openai": { "display:order": 0 },
        } as Record<string, AIModeConfigType>;
        expect(firstUserAIMode(configs)).toBe("alpha@openai");
    });

    it("returns null when the user defined no mode", () => {
        expect(firstUserAIMode({ "waveai@quick": {} } as Record<string, AIModeConfigType>)).toBeNull();
        expect(firstUserAIMode(null)).toBeNull();
    });
});
