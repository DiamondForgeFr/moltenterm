// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { readFileSync } from "fs";
import { atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { railCoffeeLabel } from "./keepawake-model";
import {
    RailBudChain,
    RailBudDropPx,
    RailBudFilter,
    RailBudFilterId,
    railBudReachPx,
    railBudShiftPx,
    railBudSlots,
    RailBudSpec,
    RailBudTargetPx,
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
        expect(html).toMatch(
            /^<span class="molten-rail-bud" style="--molten-rail-bud-reach:35px;--molten-rail-bud-span:18px">/
        );
        expect(html).toMatch(
            /<button type="button" aria-label="Edit Client A" data-role="rail-edit"[^>]*class="molten-rail-budbtn [^"]*molten-rail-edit/
        );
        expect(html).toContain('data-role="rail-edit"');
        expect(html).not.toContain("tabindex");
    });

    it("has a 30 px target and a pointer cursor (#390)", () => {
        expect(html).toContain("h-[30px] w-[30px]");
        expect(html).toContain("cursor-pointer");
        expect(html).not.toContain("cursor-help");
    });
});

describe("the pencil buds out to the right (#365, FR-SHELL-030-AC17 to AC19)", () => {
    const css = source("./moltenterm-shell.css");

    it("draws the tile, the stem and the drop through the goo filter, under the badge, hidden from assistive technology", () => {
        const place = "--i:0;--x:20px;--y:0px;--sx:-4px;--sy:0px;--len:24px;--angle:0deg";
        expect(render()).toContain(
            `<span class="molten-rail-bud-clip" aria-hidden="true"><span class="molten-rail-bud-goo" style="filter:url(#molten-rail-bud-goo)"><span class="molten-rail-bud-tile"></span><span class="molten-rail-bud-stem" style="${place}"></span><span class="molten-rail-bud-drop" style="${place}"></span></span></span><span class="molten-rail-bud-bridge" aria-hidden="true"></span><button`
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
        expect(bud).toContain("top: calc(anchor(center) - 64px)");
        expect(bud).toContain("width: var(--molten-rail-bud-reach)");
        expect(bud).toContain("height: 128px");
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

    it("settles before the pinch-off: the stem stays out to the drop, joined by a neck (#390)", () => {
        const shown = ".molten-rail-budhost:is(:hover, :has(:focus-visible), [data-buds-out]) > .molten-rail-bud";
        const stem = cssRule(css, `${shown} .molten-rail-bud-stem`);
        expect(stem).toContain("scale: 1 1;");
        const resting = cssRule(css, ".molten-rail-bud-stem");
        expect(resting).toContain("scale: 0 1;");
        expect(resting).toContain("rotate: var(--angle);");
        expect(resting).toContain("width: var(--len);");
        expect(resting).toContain("transform-origin: 0 50%;");
        const drop = cssRule(css, `${shown} .molten-rail-bud-drop`);
        expect(drop).toContain("translate: 0 0;");
        expect(drop).toContain("scale: 1;");
        // The drop leaves from the start of its stem and grows out of it.
        expect(css).toMatch(
            /\n\.molten-rail-bud-drop \{[^}]*translate: calc\(var\(--sx\) - var\(--x\)\) calc\(var\(--sy\) - var\(--y\)\);/
        );
        expect(css).not.toContain(`${shown} .molten-rail-bud-goo {`);
    });

    it("puts the item's tile in the goo, so the tile stretches toward the neck, lit with its item", () => {
        const tile = cssRule(css, ".molten-rail-bud-tile");
        expect(tile).toContain("height: var(--molten-rail-item-h);");
        expect(tile).toContain("top: calc(64px - var(--molten-rail-item-h) / 2);");
        expect(cssRule(css, ".molten-rail-budhost")).toContain("--molten-rail-item-h: 36px;");
        expect(tile).toContain("border-radius: 0 var(--mt-radius-4) var(--mt-radius-4) 0;");
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
        const settled = cssRule(
            css,
            ".molten-rail-bud[data-reduced-motion] .molten-rail-bud-stem,\n.molten-rail-bud[data-reduced-motion] .molten-rail-bud-drop"
        );
        expect(settled).toContain("translate: none;");
        expect(settled).toContain("scale: none;");
        expect(cssRule(css, ".molten-rail-bud[data-reduced-motion] .molten-rail-bud-goo")).toContain(
            "transition: opacity var(--mt-duration-fast) var(--mt-ease);"
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

    it("draws a plain 28 px badge with a 12 px glyph, no hold ring, tint or edge to cut the neck (#365, #390)", () => {
        const html = render();
        expect(html).not.toContain("hold-ring");
        expect(html).not.toContain("hold-tint");
        expect(html).not.toContain("molten-hold");
        expect(html).toMatch(
            /class="molten-rail-bud-disc[^"]*h-7 w-7[^"]*bg-\[var\(--molten-rail-bud-fill\)\][^"]*text-12/
        );
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
        expect(html).toMatch(
            /^<span class="molten-rail-bud" style="--molten-rail-bud-reach:35px;--molten-rail-bud-span:18px">/
        );
        expect(html.indexOf('data-role="rail-edit"')).toBeLessThan(html.indexOf('data-role="rail-link"'));
        expect(html).toContain('aria-label="Group Client A with other workspaces" aria-pressed="false"');
        expect(html).toMatch(
            /data-role="rail-edit"[^>]*style="--i:0;--x:20px;--y:-17px;--sx:-3.7px;--sy:-6.4px;--len:25.9px;--angle:-24.1deg"/
        );
        expect(html).toMatch(
            /data-role="rail-link"[^>]*style="--i:1;--x:20px;--y:17px;--sx:-3.7px;--sy:6.4px;--len:25.9px;--angle:24.1deg"/
        );
        expect(html).toContain("fa-link");
        expect(html).toContain('<span class="molten-rail-bud-stem" style="--i:1;');
        expect(renderChain(true)).toContain('aria-pressed="true"');
    });

    it("places each bud on its own slot of the fan, from its centre and its stem", () => {
        expect(cssRule(css, ".molten-rail-bud .molten-rail-budbtn")).toContain("left: calc(var(--x) - 15px);");
        expect(cssRule(css, ".molten-rail-bud .molten-rail-budbtn")).toContain("top: calc(64px + var(--y) - 15px);");
        expect(css).toContain(".molten-rail-bud-drop {\n    left: calc(12px + var(--x) - 14px);");
        expect(css).toContain(".molten-rail-bud-stem {\n    left: calc(12px + var(--sx));");
        expect(cssRule(css, ".molten-rail-bud-clip")).toContain("width: calc(var(--molten-rail-bud-reach) + 4px);");
    });

    it("bridges the item and the buds while they are out, so the pointer goes from the item to any bud and between buds", () => {
        const bridge = cssRule(css, ".molten-rail-bud-bridge");
        expect(bridge).toContain("left: 0;");
        expect(bridge).toContain("width: calc(var(--molten-rail-bud-reach) - 15px);");
        expect(bridge).toContain("height: calc(2 * var(--molten-rail-bud-span));");
        expect(bridge).toContain("pointer-events: none;");
        expect(
            cssRule(
                css,
                ".molten-rail-budhost:is(:hover, :has(:focus-visible), [data-buds-out]) > .molten-rail-bud .molten-rail-bud-bridge"
            )
        ).toContain("pointer-events: auto;");
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

describe("the coffee bud ends the chain (#276, FR-SHELL-023-AC8 to AC10)", () => {
    const css = source("./moltenterm-shell.css");

    function renderCoffee(on: boolean, withLink: boolean): string {
        const env = {
            getSettingsKeyAtom: () => atom(undefined),
            atoms: { prefersReducedMotionAtom: atom(false) },
        };
        const buds: RailBudSpec[] = [{ kind: "edit", label: railEditLabel("Client A"), onActivate: () => {} }];
        if (withLink) {
            buds.push({ kind: "link", label: railLinkLabel("Client A"), onActivate: () => {} });
        }
        buds.push({
            kind: "coffee",
            label: railCoffeeLabel("Client A", on, "darwin"),
            pressed: on,
            onActivate: () => {},
        });
        return renderToStaticMarkup(
            <WaveEnvContext.Provider value={env as any}>
                <RailBudChain buds={buds} onHover={() => {}} onLeave={() => {}} />
            </WaveEnvContext.Provider>
        );
    }

    it("comes after the pencil and the link, a toggle named for what it does", () => {
        const html = renderCoffee(false, true);
        expect(html).toMatch(
            /^<span class="molten-rail-bud" style="--molten-rail-bud-reach:51px;--molten-rail-bud-span:25px">/
        );
        expect(html.indexOf('data-role="rail-link"')).toBeLessThan(html.indexOf('data-role="rail-coffee"'));
        expect(html).toContain('aria-label="Keep the Mac awake while Client A works" aria-pressed="false"');
        expect(html).toMatch(
            /data-role="rail-edit"[^>]*style="--i:0;--x:18px;--y:-25px;--sx:-3.3px;--sy:-10.2px;--len:25.9px;--angle:-34.8deg"/
        );
        expect(html).toMatch(
            /data-role="rail-link"[^>]*style="--i:1;--x:36px;--y:0px;--sx:-4px;--sy:0px;--len:40px;--angle:0deg"/
        );
        expect(html).toMatch(
            /data-role="rail-coffee"[^>]*style="--i:2;--x:18px;--y:25px;--sx:-3.3px;--sy:10.2px;--len:25.9px;--angle:34.8deg"/
        );
        expect(html).toContain("fa-mug-hot");
        expect(html).not.toContain("tabindex");
        const on = renderCoffee(true, false);
        expect(on).toContain('aria-label="Stop keeping the Mac awake for Client A" aria-pressed="true"');
        expect(on).toMatch(/data-role="rail-coffee"[^>]*style="--i:1;--x:20px;--y:17px/);
    });

    it("is filled in the awake colour while on, and leaves a droplet out of hover", () => {
        expect(cssRule(css, '.molten-rail-coffee[aria-pressed="true"] .molten-rail-bud-disc')).toContain(
            "background-color: var(--color-awake);"
        );
        expect(cssRule(css, ".molten-rail-coffee-drop")).toContain("background-color: var(--color-awake);");
        expect(css).toContain(
            ".molten-rail-budhost:is(:hover, :has(:focus-visible), [data-buds-out]) .molten-rail-coffee-drop {\n    opacity: 0;"
        );
    });
});

describe("a product's members fan out beside its icon (#381)", () => {
    const css = source("./moltenterm-shell.css");

    it("anchors the column to the group's icon, outside the rail's flow", () => {
        const members = cssRule(css, ".molten-rail-members");
        expect(members).toContain("position: fixed;");
        expect(members).toContain("position-anchor: --molten-rail-group;");
        expect(members).toContain("left: calc(anchor(right) + 8px);");
        expect(members).toContain("top: anchor(top);");
        expect(cssRule(css, ".molten-rail-unit")).toContain("anchor-scope: --molten-rail-group;");
    });

    it("gives a local group's icon both anchor names, or the column loses its anchor and covers the rail", () => {
        expect(cssRule(css, ".molten-rail-group.molten-rail-anchor")).toContain(
            "anchor-name: --molten-rail-item, --molten-rail-group;"
        );
        expect(cssRule(css, ".molten-rail-unit[data-rail-local] > .molten-rail-members")).toContain(
            "left: calc(anchor(right) + 38px);"
        );
        // The column starts past the group's link bud.
        expect(railBudReachPx(1)).toBeLessThan(38);
    });
});

describe("the buds fan out of the item as separate droplets (#390)", () => {
    const itemHalf = 18;

    it("fans three buds up-right, right and down-right, and keeps one or two balanced about the item's middle", () => {
        const three = railBudSlots(3);
        expect(three.map((s) => [s.x, s.y])).toEqual([
            [18, -25],
            [36, 0],
            [18, 25],
        ]);
        expect(three[0].stemAngle).toBeLessThan(0);
        expect(three[1].stemAngle).toBe(0);
        expect(three[2].stemAngle).toBeGreaterThan(0);
        for (const count of [1, 2, 3]) {
            const slots = railBudSlots(count);
            expect(slots).toHaveLength(count);
            expect(slots.reduce((sum, s) => sum + s.y, 0)).toBe(0);
        }
        expect(railBudSlots(0)).toEqual([]);
    });

    it("keeps every target right of the item's edge and never overlaps two targets", () => {
        for (const count of [1, 2, 3]) {
            const slots = railBudSlots(count);
            for (const slot of slots) {
                expect(slot.x - RailBudTargetPx / 2).toBeGreaterThanOrEqual(0);
            }
            for (let i = 1; i < slots.length; i++) {
                const gap = Math.hypot(slots[i].x - slots[i - 1].x, slots[i].y - slots[i - 1].y);
                expect(gap).toBeGreaterThanOrEqual(RailBudTargetPx);
            }
        }
    });

    it("gives each bud its own neck: a stem from just inside the item's edge to the drop, on the ray from the item's centre", () => {
        for (const shift of [0, 14, -14]) {
            for (const count of [1, 2, 3]) {
                for (const slot of railBudSlots(count, shift)) {
                    expect(slot.stemX).toBeLessThan(0);
                    expect(slot.stemX).toBeGreaterThanOrEqual(-4);
                    expect(Math.abs(slot.stemY)).toBeLessThan(itemHalf);
                    // The stem ends at the drop's centre.
                    const rad = (slot.stemAngle * Math.PI) / 180;
                    expect(slot.stemX + slot.stemLength * Math.cos(rad)).toBeCloseTo(slot.x, 0);
                    expect(slot.stemY + slot.stemLength * Math.sin(rad)).toBeCloseTo(slot.y, 0);
                    // On the ray from the item's centre.
                    const cross = (slot.x + itemHalf) * slot.stemY - slot.y * (slot.stemX + itemHalf);
                    expect(Math.abs(cross) / Math.hypot(slot.x + itemHalf, slot.y)).toBeLessThan(0.2);
                    expect(slot.stemLength).toBeGreaterThan(RailBudDropPx / 2);
                }
            }
        }
    });

    it("slides the fan clear of the rail's top and bottom edges, the buds still leaving the item", () => {
        // Centred 26 px under the rail's top: the pencil (25 px up, 15 px half target) would stick out 14 px.
        expect(railBudShiftPx(3, 126, 100, 1000)).toBe(14);
        expect(railBudShiftPx(3, 974, 100, 1000)).toBe(-14);
        expect(railBudShiftPx(3, 500, 100, 1000)).toBe(0);
        expect(railBudShiftPx(1, 126, 100, 1000)).toBe(0);
        expect(railBudShiftPx(0, 0, 100, 1000)).toBe(0);
        const shifted = railBudSlots(3, 14);
        expect(shifted.map((s) => s.y)).toEqual([-11, 14, 39]);
        expect(shifted.map((s) => s.x)).toEqual([18, 36, 18]);
    });

    it("sets the reach the tooltips go past", () => {
        expect(railBudReachPx(0)).toBe(0);
        expect(railBudReachPx(1)).toBe(35);
        expect(railBudReachPx(2)).toBe(35);
        expect(railBudReachPx(3)).toBe(51);
        expect(source("./workspace-rail.tsx")).toContain("railBudReachPx(buds.length) + RailBudTooltipGapPx");
        expect(source("./rail-product.tsx")).toContain("rect.right + railBudReachPx(1)");
    });
});
