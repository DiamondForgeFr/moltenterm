// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MergedFooterButtons } from "./review-done-view";
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
        expect(html).toContain("This review tab is no longer needed.");
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
