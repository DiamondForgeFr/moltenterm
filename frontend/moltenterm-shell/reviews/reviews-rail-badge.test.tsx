// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewsRailBadges } from "./reviews-rail-badge";

function badges(html: string): { toreview: string; mergeable: string } {
    const read = (cls: string) => new RegExp(`${cls}[^"]*"[^>]*>([^<]*)<`).exec(html)?.[1] ?? null;
    return { toreview: read("molten-reviews-toreview"), mergeable: read("molten-reviews-mergeable") };
}

describe("ReviewsRailBadges (#688 AC4, #775)", () => {
    it("draws nothing for 0", () => {
        expect(renderToStaticMarkup(<ReviewsRailBadges counts={{ toreview: 0, mergeable: 0, drafts: 0 }} />)).toBe("");
        expect(renderToStaticMarkup(<ReviewsRailBadges counts={null} />)).toBe("");
    });

    it("draws the count to review on top and the mergeable count at the bottom in the success colour", () => {
        const html = renderToStaticMarkup(<ReviewsRailBadges counts={{ toreview: 5, mergeable: 4, drafts: 0 }} />);
        expect(badges(html)).toEqual({ toreview: "5", mergeable: "4" });
        expect(html).toMatch(/molten-reviews-toreview[^"]*top-0/);
        expect(html).toMatch(/molten-reviews-mergeable[^"]*bottom-0[^"]*bg-success/);
        expect(html).not.toMatch(/animate-/);
        expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
    });

    it("draws one badge when one count is 0", () => {
        expect(
            badges(renderToStaticMarkup(<ReviewsRailBadges counts={{ toreview: 1, mergeable: 0, drafts: 0 }} />))
        ).toEqual({
            toreview: "1",
            mergeable: null,
        });
        expect(
            badges(renderToStaticMarkup(<ReviewsRailBadges counts={{ toreview: 0, mergeable: 3, drafts: 0 }} />))
        ).toEqual({
            toreview: null,
            mergeable: "3",
        });
    });

    it("shows real numbers up to 99", () => {
        expect(
            badges(renderToStaticMarkup(<ReviewsRailBadges counts={{ toreview: 2, mergeable: 11, drafts: 0 }} />))
        ).toEqual({
            toreview: "2",
            mergeable: "11",
        });
        expect(
            badges(renderToStaticMarkup(<ReviewsRailBadges counts={{ toreview: 120, mergeable: 99, drafts: 0 }} />))
        ).toEqual({
            toreview: "99+",
            mergeable: "99",
        });
    });

    it("draws the open drafts at the bottom left in grey, apart from the two others (#934)", () => {
        const drafts = (html: string) =>
            new RegExp(`molten-reviews-drafts[^"]*"[^>]*>([^<]*)<`).exec(html)?.[1] ?? null;
        const html = renderToStaticMarkup(<ReviewsRailBadges counts={{ toreview: 2, mergeable: 1, drafts: 3 }} />);
        expect(drafts(html)).toBe("3");
        expect(badges(html)).toEqual({ toreview: "2", mergeable: "1" });
        expect(html).toMatch(/molten-reviews-drafts[^"]*bottom-0[^"]*left-0[^"]*bg-muted/);
        expect(html).toMatch(/class="[^"]*ring-2[^"]*molten-reviews-drafts/);
        expect(html).not.toMatch(/molten-reviews-drafts[^"]*right-0/);
        expect(html).toMatch(/molten-reviews-toreview[^"]*right-0/);
        expect(html).toMatch(/molten-reviews-mergeable[^"]*right-0/);
        expect(html.match(/aria-hidden="true"/g)).toHaveLength(3);
        expect(
            drafts(renderToStaticMarkup(<ReviewsRailBadges counts={{ toreview: 0, mergeable: 0, drafts: 1 }} />))
        ).toBe("1");
        expect(
            drafts(renderToStaticMarkup(<ReviewsRailBadges counts={{ toreview: 0, mergeable: 0, drafts: 140 }} />))
        ).toBe("99+");
        expect(
            drafts(renderToStaticMarkup(<ReviewsRailBadges counts={{ toreview: 4, mergeable: 2, drafts: 0 }} />))
        ).toBe(null);
    });
});
