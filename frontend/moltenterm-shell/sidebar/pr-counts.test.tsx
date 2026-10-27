// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrPips } from "./pr-counts";

describe("PrPips (FR-SHELL-085)", () => {
    it("draws one tinted pill per kind with counts, in the order ready, CI, draft", () => {
        const html = renderToStaticMarkup(
            <PrPips counts={{ ready: 3, ci: 1, draft: 2 }} motionKey="tile:a" calm={false} />
        );
        const kinds = [...html.matchAll(/data-kind="(\w+)"/g)].map((m) => m[1]);
        expect(kinds).toEqual(["ready", "ci", "draft"]);
        expect(html).toMatch(/mt-sb-pip is-ready[^>]*>3</);
        expect(html).toContain('title="3 pull requests ready"');
        expect(html).toContain('title="1 pull request with CI running or failing"');
        expect(html).not.toContain("is-calm");
        expect(html).not.toContain("is-bump");
    });

    it("leaves out an empty kind and draws nothing without counts", () => {
        const html = renderToStaticMarkup(<PrPips counts={{ ready: 0, ci: 0, draft: 4 }} motionKey="k" calm />);
        expect(html).not.toContain("is-ready");
        expect(html).toContain("is-calm");
        expect(renderToStaticMarkup(<PrPips counts={{ ready: 0, ci: 0, draft: 0 }} motionKey="k" calm />)).toBe("");
    });

    it("takes the small size in the top row", () => {
        const html = renderToStaticMarkup(<PrPips counts={{ ready: 1, ci: 0, draft: 0 }} motionKey="k" calm small />);
        expect(html).toContain("mt-sb-pips is-small");
    });
});
