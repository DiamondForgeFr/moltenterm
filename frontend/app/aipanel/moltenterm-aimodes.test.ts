// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { firstUserAIMode, isUserAIMode } from "@/app/aipanel/moltenterm-aimodes";
import { describe, expect, it } from "vitest";

function mode(name: string, order?: number): AIModeConfigType {
    return { "display:name": name, "display:order": order };
}

describe("Moltenterm AI modes", () => {
    it("treats waveai@ modes as Wave's, everything else as the user's", () => {
        expect(isUserAIMode("waveai@balanced")).toBe(false);
        expect(isUserAIMode("ollama@llama")).toBe(true);
    });

    it("picks the user's first mode by display:order, then by name", () => {
        const configs: Record<string, AIModeConfigType> = {
            "waveai@balanced": mode("Balanced", -2),
            "zeta@local": mode("Zeta", 1),
            "beta@openai": mode("Beta", 0),
            "alpha@openai": mode("Alpha", 0),
        };
        expect(firstUserAIMode(configs)).toBe("alpha@openai");
    });

    it("returns null when the user defined no mode", () => {
        expect(firstUserAIMode({ "waveai@quick": mode("Quick") })).toBeNull();
        expect(firstUserAIMode(null)).toBeNull();
    });
});
