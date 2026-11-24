// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { shownLinkUri, TermLinkTooltipContent } from "./term-link-tooltip";

const TooltipSource = readFileSync(join(__dirname, "../../app/view/term/term-tooltip.tsx"), "utf8");

describe("the terminal link preview (#2507)", () => {
    it("names the link's real target above the modifier hint", () => {
        const html = renderToStaticMarkup(<TermLinkTooltipContent uri="https://github.com/DiamondForgeFr" />);
        expect(html).toContain("https://github.com/DiamondForgeFr");
        expect(html).toMatch(/(Cmd|Ctrl)-click to open link/);
        expect(html.indexOf("https://github.com")).toBeLessThan(html.indexOf("-click"));
    });

    it("escapes the URL as text", () => {
        const html = renderToStaticMarkup(<TermLinkTooltipContent uri={'https://x.test/"><img src=x>'} />);
        expect(html).not.toContain("<img");
    });

    it("cuts a very long URL", () => {
        const long = "https://example.com/" + "a".repeat(1000);
        expect(shownLinkUri(long).length).toBe(300);
        expect(shownLinkUri("https://github.com")).toBe("https://github.com");
    });

    it("is the preview the terminal's link tooltip shows", () => {
        expect(TooltipSource).toContain("<TermLinkTooltipContent uri={hoveredUri} />");
        expect(TooltipSource).toContain("setHoveredUri(uri)");
    });
});
