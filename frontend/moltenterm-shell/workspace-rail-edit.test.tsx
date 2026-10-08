// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { readFileSync } from "fs";
import { atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
    RailBudChain,
    RailBudFilter,
    RailBudFilterId,
    RailBudPitchPx,
    RailEditButton,
    railEditLabel,
    railLinkLabel,
} from "./workspace-rail-edit";

function render(settings: Record<string, unknown> = {}, reducedMotion = false): string {
    const env = {
        getSettingsKeyAtom: (key: string) => atom(settings[key]),
        atoms: { prefersReducedMotionAtom: atom(reducedMotion) },
    };
    return renderToStaticMarkup(
        <WaveEnvContext.Provider value={env as any}>
            <RailEditButton name="Client A" onEdit={() => {}} onHover={() => {}} onLeave={() => {}} />
        </WaveEnvContext.Provider>
    );
}

function source(name: string): string {
    return readFileSync(new URL(name, import.meta.url), "utf8");
}

function cssRule(css: string, selector: string): string {
    const start = css.indexOf("\n" + selector + " {");
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
}

describe("rail pencil (FR-SHELL-030-AC1)", () => {
    const html = render();

    it("is a real button named after the workspace, inside its bud", () => {
        expect(html).toMatch(/^<span class="molten-rail-bud" style="--molten-rail-buds:1">/);
        expect(html).toMatch(
            /<button type="button" aria-label="Edit Client A" data-role="rail-edit"[^>]*class="molten-rail-budbtn [^"]*molten-rail-edit/
        );
        expect(html).toContain('data-role="rail-edit"');
        expect(html).not.toContain("tabindex");
    });

    it("has a 24 px target and a pointer cursor", () => {
        expect(html).toContain("h-6 w-6");
        expect(html).toContain("cursor-pointer");
        expect(html).not.toContain("cursor-help");
    });
});

describe("the pencil buds out to the right (#365, FR-SHELL-030-AC17 to AC19)", () => {
    const css = source("./moltenterm-shell.css");

    it("draws the tile, the stub and the drop through the goo filter, under the badge, hidden from assistive technology", () => {
        expect(render()).toMatch(
            /<span class="molten-rail-bud-clip" aria-hidden="true"><span class="molten-rail-bud-goo" style="filter:url\(#molten-rail-bud-goo\)"><span class="molten-rail-bud-tile"><\/span><span class="molten-rail-bud-stub" style="--i:0"><\/span><span class="molten-rail-bud-drop" style="--i:0"><\/span><\/span><\/span><button/
        );
    });

    it("defines the metaball filter: a blur, then an alpha threshold", () => {
        const svg = renderToStaticMarkup(<RailBudFilter />);
        expect(svg).toContain(`<filter id="${RailBudFilterId}"`);
        expect(svg).toContain("<feGaussianBlur");
        expect(svg).toMatch(/<feColorMatrix[^>]*values="1 0 0 0 0 {2}0 1 0 0 0 {2}0 0 1 0 0 {2}0 0 0 40 -19.5"/);
        expect(svg).toContain('aria-hidden="true"');
    });

    it("is anchored right of its own item, fixed so the rail's width and scroll do not clip it", () => {
        expect(cssRule(css, ".molten-rail-budhost")).toContain("anchor-scope: --molten-rail-item");
        expect(cssRule(css, ".molten-rail-anchor")).toContain("anchor-name: --molten-rail-item");
        const bud = cssRule(css, ".molten-rail-bud");
        expect(bud).toContain("position: fixed");
        expect(bud).toContain("position-anchor: --molten-rail-item");
        expect(bud).toContain("position-visibility: anchors-visible");
        expect(bud).toContain("left: anchor(right)");
        expect(bud).toContain("top: calc(anchor(center) - 12px)");
        expect(bud).toContain("width: calc(24px + 28px * (var(--molten-rail-buds, 1) - 1))");
        expect(bud).toContain("pointer-events: none");
    });

    it("never lets the hidden badge catch a click; hover and a keyboard focus show it", () => {
        expect(cssRule(css, ".molten-rail-bud .molten-rail-budbtn")).toContain("pointer-events: none");
        expect(css).toMatch(
            /\.molten-rail-budhost:is\(:hover, :has\(:focus-visible\), \[data-buds-out\]\) > \.molten-rail-bud \.molten-rail-budbtn[^{]*\{\s*opacity: 1;\s*pointer-events: auto;/
        );
    });

    it("clips the goo at the icon's edge, so nothing of the bud covers the icon", () => {
        const clip = cssRule(css, ".molten-rail-bud-clip");
        expect(clip).toContain("left: 0;");
        expect(clip).toContain("overflow: hidden");
    });

    it("settles before the pinch-off: the stub stays out by the drop, joined by a neck", () => {
        const shown = ".molten-rail-budhost:is(:hover, :has(:focus-visible), [data-buds-out]) > .molten-rail-bud";
        const stub = cssRule(css, `${shown} .molten-rail-bud-stub`);
        expect(stub).toContain("translate: -2px 0;");
        expect(stub).toContain("scale: 1;");
        const drop = cssRule(css, `${shown} .molten-rail-bud-drop`);
        expect(drop).toContain("translate: 0 0;");
        expect(drop).toContain("scale: 1;");
        // Stub 12 px centred 2 px inside the edge, drop 16 px centred 12 px past it: they touch, the blur makes the waist.
        expect(css).not.toContain(`${shown} .molten-rail-bud-goo {`);
    });

    it("puts the item's tile in the goo, so the tile stretches toward the neck, lit with its item", () => {
        const tile = cssRule(css, ".molten-rail-bud-tile");
        expect(tile).toContain("height: var(--molten-rail-item-h);");
        expect(tile).toContain("top: calc(16px - var(--molten-rail-item-h) / 2);");
        expect(cssRule(css, ".molten-rail-budhost")).toContain("--molten-rail-item-h: 36px;");
        expect(cssRule(css, ".molten-rail-budhost[data-rail-member]")).toContain("--molten-rail-item-h: 32px;");
        expect(tile).toContain("border-radius: 0 4px 4px 0;");
        expect(tile).toContain("opacity: 0;");
        const shown =
            ".molten-rail-budhost:is(:hover, :has(:focus-visible), [data-buds-out]) > .molten-rail-bud .molten-rail-bud-tile";
        expect(cssRule(css, shown)).toContain("opacity: 1;");
        expect(
            cssRule(css, ".molten-rail-budhost:is(:hover, :has(:focus-visible), [data-buds-out]) > .molten-rail-anchor")
        ).toContain("background-color: var(--color-hover);");
        const svg = renderToStaticMarkup(<RailBudFilter />);
        expect(svg).toContain('color-interpolation-filters="sRGB"');
    });

    it("animates translate, scale and opacity only, and shows the settled droplet with a fade under reduced motion", () => {
        const section = css.slice(css.indexOf(".molten-rail-budhost {"), css.indexOf("/* The command palette's"));
        const transitions = section.match(/transition:[^;]*;/g).join(" ");
        const properties = transitions.match(/\b(translate|scale|opacity|transform|width|height|left|top|filter)\b/g);
        expect(new Set(properties)).toEqual(new Set(["translate", "scale", "opacity"]));
        const reduced = render({}, true);
        expect(reduced).toContain('data-reduced-motion=""');
        expect(reduced).toContain("molten-rail-bud-goo");
        expect(reduced).toContain("fa-pencil");
        const settled = cssRule(css, ".molten-rail-bud[data-reduced-motion] .molten-rail-bud-stub");
        expect(settled).toContain("translate: -2px 0;");
        expect(cssRule(css, ".molten-rail-bud[data-reduced-motion] .molten-rail-bud-goo")).toContain(
            "transition: opacity 120ms linear;"
        );
    });

    it("hides with its dragged item", () => {
        expect(cssRule(css, ".molten-rail-dragging .molten-rail-bud")).toContain("visibility: hidden");
    });
});

describe("rail order menus (#365, FR-MC-031-AC8)", () => {
    it("no longer offer Move up and Move down; the keyboard moves stay", () => {
        for (const file of ["./workspace-rail.tsx", "./rail-product.tsx"]) {
            const code = source(file);
            expect(code).not.toContain('"Move up"');
            expect(code).not.toContain('"Move down"');
            expect(code).toContain("railMoveKey(e)");
        }
    });

    it("makes every item the anchor of its own pencil", () => {
        const code = source("./workspace-rail.tsx");
        expect(code).toContain('"molten-rail-budhost relative shrink-0"');
        expect(code).toContain("molten-rail-item molten-rail-anchor");
        expect(code).toContain("<RailBudFilter />");
    });
});

describe("a simple click edits (#368, revision of FR-SHELL-030, 2026-10-08)", () => {
    it("names the pencil without a hold", () => {
        expect(railEditLabel("Client A")).toBe("Edit Client A");
    });

    it("draws a plain 16 px badge with no hold ring, tint or edge to cut the neck (#365)", () => {
        const html = render();
        expect(html).not.toContain("hold-ring");
        expect(html).not.toContain("hold-tint");
        expect(html).not.toContain("molten-hold");
        expect(html).toMatch(/class="molten-rail-bud-disc[^"]*h-4 w-4[^"]*bg-\[var\(--molten-rail-bud-fill\)\]/);
        expect(html).toContain("fa-pencil");
    });

    it("ignores the hold setting, which stays for the tab close buttons", () => {
        expect(render({ "tab:holdtoclose": true })).toBe(render({ "tab:holdtoclose": false }));
    });

    it("never starts a drag of the rail item", () => {
        expect(render()).toContain('draggable="false"');
    });

    it("follows reduced motion for the droplet", () => {
        expect(render()).not.toContain("data-reduced-motion");
        expect(render({}, true)).toContain('data-reduced-motion=""');
    });
});

describe("the bud chain: pencil, link, coffee (#368, DS-MC-029)", () => {
    const css = source("./moltenterm-shell.css");

    function renderChain(pressed: boolean): string {
        const env = {
            getSettingsKeyAtom: () => atom(undefined),
            atoms: { prefersReducedMotionAtom: atom(false) },
        };
        return renderToStaticMarkup(
            <WaveEnvContext.Provider value={env as any}>
                <RailBudChain
                    buds={[
                        { kind: "edit", label: railEditLabel("Client A"), onActivate: () => {} },
                        { kind: "link", label: railLinkLabel("Client A"), pressed, onActivate: () => {} },
                    ]}
                    onHover={() => {}}
                    onLeave={() => {}}
                />
            </WaveEnvContext.Provider>
        );
    }

    it("puts the link bud right after the pencil, a plain button named after the item", () => {
        const html = renderChain(false);
        expect(html).toMatch(/^<span class="molten-rail-bud" style="--molten-rail-buds:2">/);
        expect(html.indexOf('data-role="rail-edit"')).toBeLessThan(html.indexOf('data-role="rail-link"'));
        expect(html).toContain('aria-label="Group Client A with other workspaces" aria-pressed="false"');
        expect(html).toMatch(/data-role="rail-link"[^>]*style="left:28px;--i:1"/);
        expect(html).toContain("fa-link");
        expect(html).toContain('<span class="molten-rail-bud-stub" style="--i:1"></span>');
        expect(renderChain(true)).toContain('aria-pressed="true"');
    });

    it("grows each later bud 28 px further, joined by its own neck, and covers the gaps between targets", () => {
        expect(RailBudPitchPx).toBe(28);
        expect(css).toContain(".molten-rail-bud-drop {\n    left: calc(14px + 28px * var(--i, 0));");
        expect(css).toContain(".molten-rail-bud-stub {\n    left: calc(4px + 28px * var(--i, 0));");
        expect(cssRule(css, ".molten-rail-bud-clip")).toContain(
            "width: calc(32px + 28px * (var(--molten-rail-buds, 1) - 1));"
        );
        const gap = cssRule(css, ".molten-rail-budbtn + .molten-rail-budbtn::before");
        expect(gap).toContain("left: -4px;");
        expect(gap).toContain("width: 4px;");
    });

    it("keeps the target's chain out and its link filled in connect mode", () => {
        expect(cssRule(css, '.molten-rail-link[aria-pressed="true"] .molten-rail-bud-disc')).toContain(
            "background-color: var(--color-accent);"
        );
        expect(cssRule(css, ".molten-rail-connect-target")).toContain("0 0 0 2px var(--color-accent)");
        expect(cssRule(css, ".molten-rail-connect-target[data-connect-drop]")).toContain(
            "0 0 0 3px var(--color-accent)"
        );
        expect(css).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*\.molten-rail-connect-target \{\s*animation: none;/
        );
    });

    it("draws the pencil alone when the link does not apply", () => {
        expect(render()).not.toContain("rail-link");
    });
});
