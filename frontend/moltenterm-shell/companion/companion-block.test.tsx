// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { setSectionUnfolded } from "./companion-arrange-model";
import { BlockCapBar, CompanionBlock } from "./companion-block";
import { BlockCapContext, makeBlockCapValue } from "./companion-block-cap";
import { DefaultCompanionLayout } from "./companion-layout";

const noop = () => {};

function inLanguage<T>(language: string, run: () => T): T {
    const i18n = I18nModel.getInstance();
    try {
        i18n.setLanguageSetting(language);
        return run();
    } finally {
        i18n.setLanguageSetting("");
    }
}

const bar = (props: Partial<Parameters<typeof BlockCapBar>[0]> = {}) =>
    renderToStaticMarkup(<BlockCapBar open={false} hidden={0} onToggle={noop} {...props} />);

describe("the bar at the foot of a block taller than its cap (#2477)", () => {
    it("is a real button that says how many the block hides and unfolds it", () => {
        const html = bar({ hidden: 18 });
        expect(html).toMatch(/^<button type="button" class="mt-cb-cap"/);
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain("Show all · 18 more");
        expect(html).toContain("fa-chevron-down");
        expect(html).not.toContain("fa-chevron-up");
        expect(html).toContain('data-testid="companion-block-cap"');
    });

    it("says a plain 'Show all' for a block without rows to count", () => {
        const html = bar({ hidden: 0 });
        expect(html).toContain("<span>Show all</span>");
        expect(html).not.toContain("more");
    });

    it("says 'Show less' with an up chevron once it is unfolded, whatever the block hides", () => {
        for (const hidden of [0, 18]) {
            const html = bar({ open: true, hidden });
            expect(html).toContain('aria-expanded="true"');
            expect(html).toContain("<span>Show less</span>");
            expect(html).toContain("fa-chevron-up");
            expect(html).not.toContain("fa-chevron-down");
        }
    });

    it("is named in French as in English, with the block's own count", () => {
        inLanguage("fr", () => {
            expect(bar({ hidden: 18 })).toContain("Tout afficher · 18 de plus");
            expect(bar({ hidden: 0 })).toContain("<span>Tout afficher</span>");
            expect(bar({ open: true })).toContain("<span>Réduire</span>");
        });
    });

    it("is described by the block's name, and held still while the dashboard is arranged", () => {
        expect(bar({ describedBy: "name-1" })).toContain('aria-describedby="name-1"');
        expect(bar({ describedBy: undefined })).not.toContain("aria-describedby");
        expect(bar({ inert: true })).toContain('inert=""');
        expect(bar()).not.toContain("inert");
    });
});

describe("a block of the flow and its cap (#2477)", () => {
    const block = (id = "files") => (
        <CompanionBlock flowId={id} label="Files changed" rows=".row">
            <div className="row">a.ts</div>
        </CompanionBlock>
    );

    it("is exactly what it was until it is measured tall: no bar, no clamp, no fade", () => {
        const plain = renderToStaticMarkup(block());
        const value = makeBlockCapValue(DefaultCompanionLayout, noop);
        const capped = renderToStaticMarkup(
            <BlockCapContext.Provider value={value}>{block()}</BlockCapContext.Provider>
        );
        expect(capped).toBe(plain);
        expect(capped).not.toContain("mt-cb-cap");
        expect(capped).not.toContain("data-capped");
        expect(capped).not.toContain("data-open");
    });

    it("is the same, unfolded in the layout, while its content is short: nothing to show", () => {
        const layout = setSectionUnfolded(DefaultCompanionLayout, "files", true);
        const html = renderToStaticMarkup(
            <BlockCapContext.Provider value={makeBlockCapValue(layout, noop)}>{block()}</BlockCapContext.Provider>
        );
        expect(html).toBe(renderToStaticMarkup(block()));
    });

    it("keeps the rows selector out of the page", () => {
        expect(renderToStaticMarkup(block())).not.toContain("rows=");
    });

    it("leaves the main agent's block, which is no block of the flow, with no cap whatever the dashboard says", () => {
        const html = renderToStaticMarkup(
            <BlockCapContext.Provider value={makeBlockCapValue(DefaultCompanionLayout, noop)}>
                <CompanionBlock className="mt-cdash-hero" heading="h2" label="Main agent">
                    <div>hero</div>
                </CompanionBlock>
            </BlockCapContext.Provider>
        );
        expect(html).not.toContain("data-capped");
        expect(html).not.toContain("mt-cb-cap");
    });
});
