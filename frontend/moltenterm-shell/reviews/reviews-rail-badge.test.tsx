// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewsRailBadges } from "./reviews-rail-badge";

function badges(html: string): { waiting: string; mergeable: string } {
    const read = (cls: string) => new RegExp(`${cls}[^"]*"[^>]*>([^<]*)<`).exec(html)?.[1] ?? null;
    return { waiting: read("molten-reviews-waiting"), mergeable: read("molten-reviews-mergeable") };
}

describe("ReviewsRailBadges (#688 AC4)", () => {
    it("draws nothing for 0", () => {
        expect(renderToStaticMarkup(<ReviewsRailBadges counts={{ waiting: 0, mergeable: 0 }} />)).toBe("");
        expect(renderToStaticMarkup(<ReviewsRailBadges counts={null} />)).toBe("");
    });

    it("draws the waiting count on top and the mergeable count at the bottom in the success colour", () => {
        const html = renderToStaticMarkup(<ReviewsRailBadges counts={{ waiting: 3, mergeable: 1 }} />);
        expect(badges(html)).toEqual({ waiting: "3", mergeable: "1" });
        expect(html).toMatch(/molten-reviews-waiting[^"]*top-0/);
        expect(html).toMatch(/molten-reviews-mergeable[^"]*bottom-0[^"]*bg-success/);
        expect(html).not.toMatch(/animate-/);
        expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
    });

    it("draws one badge when nothing can merge yet", () => {
        expect(badges(renderToStaticMarkup(<ReviewsRailBadges counts={{ waiting: 1, mergeable: 0 }} />))).toEqual({
            waiting: "1",
            mergeable: null,
        });
    });

    it("caps both counts at 9+", () => {
        const html = renderToStaticMarkup(<ReviewsRailBadges counts={{ waiting: 12, mergeable: 10 }} />);
        expect(badges(html)).toEqual({ waiting: "9+", mergeable: "9+" });
    });
});
