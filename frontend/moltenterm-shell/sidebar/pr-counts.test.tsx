// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrDots } from "./pr-counts";

const Counts = { blocked: 0, yours: 0, ready: 0, waiting: 0, agents: 0 };

describe("PrDots (FR-SHELL-085, #1304; FR-SHELL-098, #1327)", () => {
    it("draws one dot per section with pull requests, top to bottom, without numbers", () => {
        const html = renderToStaticMarkup(
            <PrDots
                counts={{ blocked: 1, yours: 2, ready: 3, waiting: 1, agents: 2 }}
                motionKey="tile:a"
                calm={false}
            />
        );
        const kinds = [...html.matchAll(/data-kind="(\w+)"/g)].map((m) => m[1]);
        expect(kinds).toEqual(["blocked", "yours", "ready", "waiting", "agents"]);
        expect(html).toMatch(/class="mt-sb-prdot is-ready"[^>]*><\/span>/);
        expect(html.replace(/<[^>]*>/g, "")).toBe("");
        expect(html).not.toContain("is-calm");
        expect(html).not.toContain("is-bump");
    });

    it("names each dot after the panel's section, with the count of the PRs it lists", () => {
        const html = renderToStaticMarkup(<PrDots counts={{ ...Counts, blocked: 1, ready: 2 }} motionKey="k" calm />);
        expect(html).toContain('title="Blocked: 1 pull request"');
        expect(html).toContain('aria-label="Ready: 2 pull requests"');
        expect(html).toContain('role="group" aria-label="Blocked: 1 pull request, Ready: 2 pull requests"');
    });

    it("leaves out an empty section and draws nothing without pull requests", () => {
        const html = renderToStaticMarkup(<PrDots counts={{ ...Counts, agents: 4 }} motionKey="k" calm />);
        expect(html).not.toContain("is-ready");
        expect(html).toContain("is-calm");
        expect(renderToStaticMarkup(<PrDots counts={Counts} motionKey="k" calm />)).toBe("");
    });

    it("takes the small size in the top row", () => {
        const html = renderToStaticMarkup(<PrDots counts={{ ...Counts, ready: 1 }} motionKey="k" calm small />);
        expect(html).toContain("mt-sb-prdots is-small");
    });
});
