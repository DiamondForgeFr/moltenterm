// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RibbonButton, RibbonFace } from "./ribbon";
import { RibbonShapes } from "./ribbon-shapes";

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

    it("is cut to its context's end shape, the V point when it has none", () => {
        const moon = button({ shape: "moon" });
        expect(moon).toContain('data-shape="moon"');
        expect(moon).toContain(`--ribbon-clip:${RibbonShapes.find((s) => s.id === "moon").clip}`);
        expect(button()).toContain('data-shape="v"');
        expect(button({ shape: "triangle" })).toContain('data-shape="v"');
    });

    it("draws every one of the fifteen shapes with its own cut", () => {
        const clips = RibbonShapes.map((s) => /--ribbon-clip:([^;"]*)/.exec(button({ shape: s.id }))?.[1]);
        expect(new Set(clips).size).toBe(15);
    });
});

// #2519: the activity signal reaches the ribbon as data-heat, 0 to 3; nothing is drawn or runs at 0.
describe("the ribbon's heat", () => {
    it("carries the heat as a data attribute on the button and on its shape", () => {
        expect(button()).toContain('data-heat="0"');
        const html = button({ heat: 2 });
        expect(html.match(/data-heat="2"/g)).toHaveLength(2);
    });

    it("draws the bath's reflection in the sidebar only while an agent works", () => {
        expect(button({ heat: 0 })).not.toContain("mt-ribbon-rim");
        expect(button({ heat: 0 })).not.toContain("mt-ribbon-halo");
        for (const heat of [1, 2, 3]) {
            const html = button({ heat });
            expect(html).toContain("mt-ribbon-rim");
            expect(html).toContain("mt-ribbon-halo");
            expect(html).not.toContain("mt-ribbon-glow");
        }
    });

    it("keeps a still glow in the collapsed ribbon, and no reflection", () => {
        const html = button({ rolled: true, heat: 1 });
        expect(html).toContain("mt-ribbon-glow");
        expect(html).not.toContain("mt-ribbon-rim");
        expect(html).not.toContain("mt-ribbon-halo");
        expect(button({ rolled: true, heat: 0 })).not.toContain("mt-ribbon-glow");
    });

    it("lights nothing on the ribbons of the menu", () => {
        const html = renderToStaticMarkup(<RibbonFace emblem="book" name="Book" paint="red" ink="white" />);
        expect(html).not.toMatch(/mt-ribbon-(rim|halo|glow)/);
    });

    it("hides the light from assistive technology", () => {
        expect(button({ heat: 1 })).toMatch(/<span class="mt-ribbon-rim" aria-hidden="true">/);
    });
});

describe("the ribbon's stylesheet", () => {
    it("cuts the notch on its own layer, so the focus ring and the dot are never clipped", () => {
        expect(Css).toMatch(/\.mt-ribbon-shape::before \{[^}]*clip-path: var\(--ribbon-clip, polygon\(/);
        expect(Css).not.toMatch(/\.mt-ribbon \{[^}]*clip-path/);
        expect(Css).not.toMatch(/\.mt-ribbon-shape \{[^}]*clip-path/);
    });

    it("rolls up with its tail fading and unrolls under the pointer, the focus and the open menu", () => {
        expect(Css).toMatch(/\.mt-ribbon\.is-rolled \.mt-ribbon-shape::before \{[^}]*mask-image: linear-gradient/);
        expect(Css).toMatch(/\.mt-ribbon\.is-rolled:is\(:hover, :focus-visible, \[aria-expanded="true"\]\) \.mt-ribbon-name/);
    });

    // #2476: rolled at rest it is its emblem and nothing more, and the collapsed ribbon starts below the header row and a
    // margin, whatever a panel's header holds: the pointer or the focus unrolls it over the content, never over a header.
    it("takes only its emblem's room at rest, and never reaches the header row", () => {
        expect(Css).toMatch(/\.mt-ribbon\.is-rolled \.mt-ribbon-name \{[^}]*max-width: 0;[^}]*opacity: 0;[^}]*margin-left: -6px/);
        expect(Css).not.toMatch(/\.mt-ribbon\.is-rolled \{[^}]*[^-]width:/);
        const edge = Css.match(/\.mt-ribbon-edge \{([^}]*)\}/)?.[1] ?? "";
        expect(edge).toMatch(/top: calc\(var\(--mt-frame-gap, 8px\) \+ var\(--header-height, 28px\) \+ [1-9]\d*px\)/);
        expect(edge).toMatch(/left: 0;/);
        expect(edge).toMatch(/position: absolute;/);
    });

    it("sits under the first panel's header, and animates through the duration tokens, which reduced motion zeroes", () => {
        expect(Css).toMatch(/\.mt-ribbon-edge \{[^}]*top: calc\(var\(--mt-frame-gap, 8px\) \+ var\(--header-height, 28px\)/);
        const withoutBreath = Css.replace(/\.mt-ribbon-rim,\s*\.mt-ribbon-halo \{[^}]*\}/, "");
        const durations = withoutBreath.match(/\d+m?s\b/g) ?? [];
        expect(durations.filter((d) => d !== "0s")).toEqual([]);
    });

    it("cuts the end shape with a clip-path the shape's own variable gives, V point by default", () => {
        expect(Css).toMatch(/\.mt-ribbon-shape::before \{[^}]*clip-path: var\(--ribbon-clip, polygon\(/);
        expect(Css).toMatch(/--mt-ribbon-notch: 8px;/);
    });

    it("paints the shape from its own variable, which the window's ribbon fills with the liseré's token", () => {
        const base = /\n\.mt-ribbon-shape::before \{([^}]*)\}/.exec(Css)?.[1] ?? "";
        expect(base).toMatch(/background: var\(--ribbon-paint, var\(--mt-place\)\);/);
        expect(base).not.toMatch(/filter|opacity:|color-mix|mix-blend-mode/);
    });
});

// #2519, mockup D: the bath's reflection and the collapsed ribbon's still glow.
describe("the bath's reflection", () => {
    // The body of the first rule whose selector is exactly this one, whitespace aside.
    const Plain = Css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => {
        const want = selector.replace(/\s+/g, " ").trim();
        for (const m of Plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            if (m[1].replace(/\s+/g, " ").trim() === want) {
                return m[2];
            }
        }
        return "";
    };

    it("is a thin rim of warm light along the ribbon's top edge, cut to its shape, screened over the paint", () => {
        const rim = rule(".mt-ribbon-rim");
        // Its box is the whole shape: a clip-path's percentages are relative to the box it cuts, so a 9px box would
        // squash the end shape and let the light leak out of it.
        expect(rim).toMatch(/inset: 0;/);
        expect(rim).not.toMatch(/height:/);
        expect(rim).toMatch(/clip-path: var\(--ribbon-clip\);/);
        expect(rim).toMatch(/linear-gradient\(180deg, rgba\(255, 215, 140, 0\.85\), rgba\(255, 160, 60, 0\) 9px\)/);
        expect(rim).toMatch(/mix-blend-mode: screen;/);
    });

    it("has a faint halo between the bath and the ribbon", () => {
        const halo = rule(".mt-ribbon-halo");
        expect(halo).toMatch(/bottom: 100%;/);
        expect(halo).toMatch(/radial-gradient\(/);
    });

    it("breathes over 7 s, in opacity only, and nothing else moves", () => {
        expect(rule(".mt-ribbon-rim, .mt-ribbon-halo")).toMatch(/animation: mt-ribbon-breathe 7s ease-in-out infinite;/);
        const keyframes = /@keyframes mt-ribbon-breathe \{([\s\S]*?)\n\}/.exec(Css)?.[1] ?? "";
        expect(keyframes).toContain("opacity:");
        expect(keyframes).not.toMatch(/transform|top:|left:|height|width|filter/);
        expect(Css.match(/@keyframes/g)).toHaveLength(1);
    });

    it("grows with the heat: one agent, two, three or more", () => {
        const gains = [1, 2, 3].map((n) => Number(/--ribbon-gain: ([\d.]+);/.exec(rule(`.mt-ribbon-shape[data-heat="${n}"]`))?.[1]));
        expect(gains[0]).toBeGreaterThan(0);
        expect(gains[1]).toBeGreaterThan(gains[0]);
        expect(gains[2]).toBeGreaterThan(gains[1]);
        expect(gains[2]).toBe(1);
    });

    it("is a still rim at about 0.7 under reduced motion, whether the system or MoltenTerm asks", () => {
        const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(Css)?.[1] ?? "";
        expect(media).toMatch(/\.mt-ribbon-rim/);
        expect(media).toMatch(/animation: none;/);
        expect(media).toMatch(/opacity: 0\.7;/);
        const own = rule(".prefers-reduced-motion .mt-ribbon-rim, .prefers-reduced-motion .mt-ribbon-halo");
        expect(own).toMatch(/animation: none;/);
        expect(own).toMatch(/opacity: 0\.7;/);
    });

    it("pauses with the window, as the sidebar's heat does", () => {
        expect(Css).toMatch(/:root\[data-mt-motion="still"\] \.mt-ribbon-rim,\s*:root\[data-mt-motion="still"\] \.mt-ribbon-halo \{\s*animation-play-state: paused;/);
    });

    it("keeps a glow with no motion for the collapsed ribbon", () => {
        const glow = rule(".mt-ribbon-glow");
        expect(glow).toMatch(/opacity: 0\.8;/);
        expect(glow).not.toMatch(/animation/);
    });
});
