// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderUsageNote } from "./companion-gauges";

// FR-AGC-008: behind another provider, one muted line takes the place of the plan gauges and says why.
describe("plan usage behind another provider", () => {
    it("shows no gauge, only why", () => {
        const html = renderToStaticMarkup(<ProviderUsageNote provider="GLM" native="Anthropic" />);
        expect(html).toContain('data-state="provider"');
        expect(html).toContain("No plan usage for GLM");
        expect(html).toContain("The plan gauges read your Anthropic plan.");
        expect(html).not.toContain("<button");
        expect(html).not.toContain("%");
    });
});
