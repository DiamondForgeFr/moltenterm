// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrDots } from "./pr-counts";

describe("PrDots (FR-SHELL-085, #1304)", () => {
    it("draws one dot per state with pull requests, top to bottom red, green, orange, grey, without numbers", () => {
        const html = renderToStaticMarkup(
            <PrDots counts={{ blocked: 1, ready: 3, ci: 1, draft: 2 }} motionKey="tile:a" calm={false} />
        );
        const kinds = [...html.matchAll(/data-kind="(\w+)"/g)].map((m) => m[1]);
        expect(kinds).toEqual(["blocked", "ready", "ci", "draft"]);
        expect(html).toMatch(/class="mt-sb-prdot is-ready"[^>]*><\/span>/);
        expect(html.replace(/<[^>]*>/g, "")).toBe("");
        expect(html).not.toContain("is-calm");
        expect(html).not.toContain("is-bump");
    });

    it("gives each dot its count as tooltip and accessible name, and the column one summary", () => {
        const html = renderToStaticMarkup(
            <PrDots counts={{ blocked: 1, ready: 2, ci: 0, draft: 0 }} motionKey="k" calm />
        );
        expect(html).toContain('title="1 pull request waiting on your decision"');
        expect(html).toContain('aria-label="2 pull requests ready to merge"');
        expect(html).toContain(
            'role="group" aria-label="1 pull request waiting on your decision, 2 pull requests ready to merge"'
        );
    });

    it("leaves out an empty state and draws nothing without pull requests", () => {
        const html = renderToStaticMarkup(
            <PrDots counts={{ blocked: 0, ready: 0, ci: 0, draft: 4 }} motionKey="k" calm />
        );
        expect(html).not.toContain("is-ready");
        expect(html).toContain("is-calm");
        expect(
            renderToStaticMarkup(<PrDots counts={{ blocked: 0, ready: 0, ci: 0, draft: 0 }} motionKey="k" calm />)
        ).toBe("");
    });

    it("takes the small size in the top row", () => {
        const html = renderToStaticMarkup(
            <PrDots counts={{ blocked: 0, ready: 1, ci: 0, draft: 0 }} motionKey="k" calm small />
        );
        expect(html).toContain("mt-sb-prdots is-small");
    });
});
