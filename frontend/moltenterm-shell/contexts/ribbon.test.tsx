// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RibbonButton, RibbonFace } from "./ribbon";

const Css = readFileSync(new URL("./ribbon.css", import.meta.url), "utf8");

function button(overrides: Partial<React.ComponentProps<typeof RibbonButton>> = {}) {
    return renderToStaticMarkup(
        <RibbonButton
            rolled={false}
            open={false}
            emblem="briefcase"
            name="DiamondForge"
            paint="#58c142"
            ink="#000000"
            label="Context DiamondForge: choose another"
            title="DiamondForge: choose a context"
            onClick={() => {}}
            {...overrides}
        />
    );
}

describe("the ribbon (FR-SHELL-159)", () => {
    it("is a button that opens a menu, named for the context and the way to change it", () => {
        const html = button();
        expect(html).toMatch(/^<button type="button"/);
        expect(html).toContain('aria-haspopup="menu"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('aria-label="Context DiamondForge: choose another"');
        expect(html).toContain('title="DiamondForge: choose a context"');
        expect(html).toContain('data-testid="context-ribbon"');
    });

    it("says it is open while its menu is", () => {
        expect(button({ open: true })).toContain('aria-expanded="true"');
    });

    it("is unrolled in the sidebar and rolled up when the sidebar is collapsed", () => {
        expect(button()).toContain('data-mode="sidebar"');
        expect(button()).not.toContain("is-rolled");
        expect(button({ rolled: true })).toContain('data-mode="collapsed"');
        expect(button({ rolled: true })).toContain("is-rolled");
    });

    it("carries the workspace's colour and the ink that reads on it, and the name", () => {
        const html = button();
        expect(html).toContain("--ribbon-paint:#58c142");
        expect(html).toContain("--ribbon-ink:#000000");
        expect(html).toContain('<span class="mt-ribbon-name">DiamondForge</span>');
    });

    it("draws a dot only while an agent waits in another context", () => {
        expect(button()).not.toContain("context-ribbon-dot");
        expect(button({ waiting: 2 })).toContain("context-ribbon-dot");
        expect(renderToStaticMarkup(<RibbonFace emblem="book" name="Book" paint="red" ink="white" />)).not.toContain(
            "context-ribbon-dot"
        );
    });
});

describe("the ribbon's stylesheet", () => {
    it("cuts the notch on its own layer, so the focus ring and the dot are never clipped", () => {
        expect(Css).toMatch(/\.mt-ribbon-shape::before \{[^}]*clip-path: polygon\(/);
        expect(Css).not.toMatch(/\.mt-ribbon \{[^}]*clip-path/);
        expect(Css).not.toMatch(/\.mt-ribbon-shape \{[^}]*clip-path/);
    });

    it("rolls up with its tail fading and unrolls under the pointer, the focus and the open menu", () => {
        expect(Css).toMatch(/\.mt-ribbon\.is-rolled \.mt-ribbon-shape::before \{[^}]*mask-image: linear-gradient/);
        expect(Css).toMatch(/\.mt-ribbon\.is-rolled:is\(:hover, :focus-visible, \[aria-expanded="true"\]\) \.mt-ribbon-name/);
    });

    it("sits under the first panel's header, and animates only through the duration tokens, which reduced motion zeroes", () => {
        expect(Css).toMatch(/\.mt-ribbon-edge \{[^}]*top: calc\(var\(--mt-frame-gap, 8px\) \+ var\(--header-height, 28px\)/);
        const durations = Css.match(/\d+m?s\b/g) ?? [];
        expect(durations.filter((d) => d !== "0s")).toEqual([]);
    });
});
