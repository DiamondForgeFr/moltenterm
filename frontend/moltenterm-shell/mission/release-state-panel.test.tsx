// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarGridColumns, NextPublicRelease } from "./release-state-panel";

const View = {
    scope: "on develop",
    total: 6,
    bars: [
        { key: "feat" as const, label: "fonctionnalités", count: 3, share: 0.5 },
        { key: "fix" as const, label: "corrections", count: 2, share: 0.33 },
        { key: "other" as const, label: "autres", count: 1, share: 0.17 },
    ],
    milestone: null,
    milestoneNote: "no milestone",
};

const Markup = renderToStaticMarkup(<NextPublicRelease view={View} />);

function classOf(testId: string): string {
    return Markup.match(new RegExp(`<div class="([^"]*)" data-testid="${testId}"`))?.[1];
}

describe("Next public release bars (#882)", () => {
    it("sizes the label column to the longest label, capped so a bar always keeps room", () => {
        expect(BarGridColumns).toBe("grid-cols-[fit-content(50%)_minmax(0,1fr)_auto]");
        const grid = classOf("release-bars").split(" ");
        expect(grid).toContain("grid");
        expect(grid).toContain(BarGridColumns);
    });

    it("puts every row on the shared columns, so all bars start at the same x", () => {
        for (const bar of View.bars) {
            const row = classOf(`release-bar-${bar.key}`).split(" ");
            expect(row).toContain("grid-cols-subgrid");
            expect(row).toContain("col-span-3");
        }
    });

    it("truncates a label instead of a fixed width, and keeps its full text in the title", () => {
        for (const bar of View.bars) {
            const label = Markup.match(
                new RegExp(`data-testid="release-bar-${bar.key}"><span class="([^"]*)" title="([^"]*)">([^<]*)</span>`)
            );
            expect(label).not.toBeNull();
            const [, classes, title, text] = label;
            expect(text).toBe(bar.label);
            expect(title).toBe(bar.label);
            expect(classes.split(" ")).toEqual(expect.arrayContaining(["truncate", "min-w-0"]));
            expect(classes).not.toMatch(/(^|\s)w-\d+(\s|$)/);
        }
    });
});
