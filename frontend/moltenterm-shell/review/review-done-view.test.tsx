// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReviewDone } from "./review-done";
import { MergedFooterButtons, ReviewMergedBanner } from "./review-done-view";
import type { ReviewTabModel } from "./review-tab-model";
import type { ReviewValidateModel } from "./review-validate-model";

function footer(inTab: boolean): string {
    const model = { host: { inTab } } as ReviewValidateModel;
    return renderToStaticMarkup(<MergedFooterButtons model={model} footer="done" plainClass="plain" />);
}

describe("the merged Validate sheet's footer", () => {
    it("asks to keep or close the Review tab it shows in (#686)", () => {
        const html = footer(true);
        expect(html).toContain('data-testid="review-keep-tab"');
        expect(html).toContain('data-testid="review-close-tab"');
        expect(html).not.toContain('data-testid="review-merged-done"');
        expect(html).toContain("This review view is no longer needed.");
    });

    it("offers only Done for a Reviews row's Validate, which opened no Review tab (#707)", () => {
        const html = footer(false);
        expect(html).toContain('data-testid="review-merged-done"');
        expect(html).toContain(">Done<");
        expect(html).not.toContain('data-testid="review-keep-tab"');
        expect(html).not.toContain('data-testid="review-close-tab"');
        expect(html).not.toMatch(/tab/i);
        expect(html).toContain("Merged and cleaned up.");
        expect(html.match(/<button/g)).toHaveLength(1);
    });
});

describe("the merged banner over a Review tab (#898)", () => {
    function banner(done: ReviewDone): string {
        const model = { doneAtom: atom(done) } as unknown as ReviewTabModel;
        return renderToStaticMarkup(<ReviewMergedBanner model={model} />);
    }

    it("says who merged the PR and into which branch, with Close and no Validate", () => {
        const html = banner({ kind: "mergedgithub", base: "develop", by: "octo" });
        expect(html).toContain('data-testid="review-merged-banner"');
        expect(html).toContain("Merged by octo, on develop. Nothing left to validate.");
        expect(html).toContain('data-testid="review-merged-close"');
        expect(html).toContain(">Close<");
        expect(html).not.toMatch(/>Validate/);
    });

    it("shows nothing while the PR is open or closed without merge", () => {
        expect(banner({ kind: "open" })).toBe("");
        expect(banner({ kind: "closed", base: "develop" })).toBe("");
    });
});
