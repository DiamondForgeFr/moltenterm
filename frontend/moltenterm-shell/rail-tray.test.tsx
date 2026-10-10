// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { makeRailUnits, productGridEntries, RailProductUnit } from "./rail-groups";
import { RailTray } from "./rail-tray";
import { railEditLabel, railMoreLabel } from "./rail-tray-model";
import { WorkspaceRailEntry } from "./workspace-rail-model";

function source(name: string): string {
    return readFileSync(new URL(name, import.meta.url), "utf8");
}

function cssRule(css: string, selector: string): string {
    const start = css.indexOf("\n" + selector + " {");
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
}

function renderTray(props: Partial<React.ComponentProps<typeof RailTray>> = {}): string {
    return renderToStaticMarkup(
        <RailTray
            open
            name="Client A"
            lead={36}
            primary={{ kind: "edit", label: railEditLabel("Client A"), onActivate: () => {} }}
            moreLabel={railMoreLabel("Client A")}
            onMore={() => {}}
            onTooltip={() => {}}
            {...props}
        />
    );
}

describe("the tray (FR-SHELL-045-AC2, DS-SHELL-080)", () => {
    it("shows the name, then Edit and More as 24 px buttons with 14 px glyphs, out of the tab order", () => {
        const html = renderTray();
        expect(html).toMatch(/^<div class="molten-rail-tray" data-open="" style="--molten-rail-tray-lead:36px">/);
        expect(html).toMatch(/<span class="min-w-0 truncate text-12 font-medium text-primary">Client A<\/span>/);
        const edit = html.indexOf('aria-label="Edit Client A"');
        const more = html.indexOf('aria-label="More actions for Client A"');
        expect(edit).toBeGreaterThan(html.indexOf("Client A</span>"));
        expect(more).toBeGreaterThan(edit);
        expect(html).toContain('aria-haspopup="menu"');
        expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
        expect(html.match(/h-6 w-6/g)).toHaveLength(2);
        expect(html.match(/text-icon-14/g)).toHaveLength(2);
        expect(html).toContain("fa-pen");
        expect(html).toContain("fa-ellipsis");
        expect(html).toContain('draggable="false"');
    });

    it("is hidden from assistive technology while folded", () => {
        expect(renderTray({ open: false })).toMatch(/^<div class="molten-rail-tray" aria-hidden="true"/);
    });

    it("puts the coffee's mug in Edit's place while on (FR-SHELL-045-AC3)", () => {
        const html = renderTray({
            primary: {
                kind: "coffee",
                label: "Stop keeping the Mac awake for Client A",
                pressed: true,
                onActivate: () => {},
            },
        });
        expect(html).not.toContain("fa-pen");
        expect(html).toContain("fa-mug-hot");
        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain("molten-rail-tray-coffee");
    });

    it("draws a 6 px state dot after the name, named", () => {
        const html = renderTray({ dot: { className: "bg-primary", label: "2 unread" } });
        expect(html).toMatch(
            /Client A<\/span><span class="molten-rail-tray-dot h-1.5 w-1.5 shrink-0 rounded-full bg-primary" role="img" aria-label="2 unread">/
        );
        expect(renderTray()).not.toContain("molten-rail-tray-dot");
    });

    it("draws a group's count after its name, and no Edit", () => {
        const html = renderTray({ name: "Notulia", detail: "3", primary: undefined });
        expect(html).toContain('<span class="shrink-0 text-11 text-muted">3</span>');
        expect(html).not.toContain("Edit");
        expect(html).toContain("fa-ellipsis");
    });
});

describe("the tray stays inside its item's row (FR-SHELL-045-AC1, NFR-SHELL-029)", () => {
    const css = source("./moltenterm-shell.css");

    it("is anchored to its item, fixed, as tall as the item, and hidden with its item scrolled out", () => {
        const tray = cssRule(css, ".molten-rail-tray");
        expect(tray).toContain("position: fixed;");
        expect(tray).toContain("position-anchor: --molten-rail-item;");
        expect(tray).toContain("position-visibility: anchors-visible;");
        expect(tray).toContain("left: anchor(left);");
        expect(tray).toContain("top: anchor(top);");
        expect(tray).toContain("bottom: anchor(bottom);");
        expect(tray).toContain("min-width: calc(var(--molten-rail-tray-lead) + 112px);");
        expect(tray).toContain("border-radius: var(--mt-radius-6);");
        expect(tray).toContain("box-shadow: var(--mt-shadow-e2);");
        expect(tray).toContain("border: 1px solid var(--mt-line-2);");
        expect(tray).toContain("pointer-events: none;");
        expect(tray).toContain("visibility: hidden;");
        expect(cssRule(css, ".molten-rail-host")).toContain("anchor-scope: --molten-rail-item;");
        expect(cssRule(css, ".molten-rail-anchor")).toContain("anchor-name: --molten-rail-item;");
    });

    it("opens in 180 ms and folds in 120 ms on the shared curve, instant under reduced motion", () => {
        const folded = cssRule(css, ".molten-rail-tray");
        expect(folded).toContain("opacity var(--mt-duration-fast) var(--mt-ease)");
        const open = cssRule(css, ".molten-rail-tray[data-open]");
        expect(open).toContain("opacity: 1;");
        expect(open).toContain("pointer-events: auto;");
        expect(open).toContain("opacity var(--mt-duration-base) var(--mt-ease)");
        const tokens = source("./tokens.css");
        expect(tokens).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--mt-duration-fast: 0ms;\s*--mt-duration-base: 0ms;/
        );
    });

    it("keeps the item's button over the tray's first 36 px, so the icon stays in place and takes the clicks", () => {
        const lifted = cssRule(css, ".molten-rail-host[data-tray-open] > .molten-rail-anchor");
        expect(lifted).toContain("z-index: 451;");
        expect(cssRule(css, ".molten-rail-tray")).toContain("z-index: 450;");
    });

    it("hides the tray of a dragged item", () => {
        expect(cssRule(css, ".molten-rail-dragging .molten-rail-tray")).toContain("visibility: hidden");
    });
});

describe("no bud or goo is left (FR-SHELL-045-AC9)", () => {
    it("removes the bud chain, its filter and its CSS", () => {
        const dir = new URL("./", import.meta.url);
        const files = readdirSync(dir).filter(
            (f) => /\.(tsx?|css)$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx")
        );
        expect(files).not.toContain("workspace-rail-edit.tsx");
        for (const file of files) {
            const code = source("./" + file);
            expect(code, file).not.toContain("molten-rail-bud");
            expect(code, file).not.toContain("RailBudChain");
            expect(code, file).not.toContain("RailBudFilter");
        }
    });

    it("drops #368's pulsing glow for a static dashed ring in connect mode (FR-SHELL-045-AC7)", () => {
        const css = source("./moltenterm-shell.css");
        const ring = cssRule(css, ".molten-rail-connect-target");
        expect(ring).toContain("outline: 1.5px dashed var(--color-accent);");
        expect(ring).not.toContain("animation");
        expect(css).not.toContain("molten-rail-connect-glow");
        expect(cssRule(css, ".molten-rail-connect-target[data-connect-drop]")).toContain(
            "outline: 2px solid var(--color-accent);"
        );
    });

    it("keeps a 6 px crema dot on the folded item while the coffee is on (FR-SHELL-045-AC3)", () => {
        const css = source("./moltenterm-shell.css");
        const dot = cssRule(css, ".molten-rail-coffee-drop");
        expect(dot).toContain("width: 6px;");
        expect(dot).toContain("height: 6px;");
        expect(dot).toContain("background-color: var(--color-awake);");
        expect(css).toContain(".molten-rail-host[data-tray-open] .molten-rail-coffee-drop {\n    opacity: 0;");
    });

    it("draws the pure workspace colour only on the 3 px active bar (DS-SHELL-082)", () => {
        const css = source("./moltenterm-shell.css");
        const bar = cssRule(css, ".molten-rail-active-bar");
        expect(bar).toContain("width: 3px;");
        expect(bar).toContain("background-color: var(--mt-accent);");
        expect(source("./workspace-icon.tsx")).toContain('"molten-glyph-tone"');
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
});

describe("groups expand inline (FR-SHELL-045-AC6, DS-SHELL-082)", () => {
    const entry = (id: string): WorkspaceRailEntry => ({
        id,
        name: id,
        icon: "star",
        color: "",
        saved: true,
        active: false,
        open: false,
    });

    it("shows the icon member first, then the others, four at most", () => {
        const entries = ["a", "b", "c", "d", "e"].map(entry);
        const units = makeRailUnits(entries, [], [{ id: "g", members: ["a", "b", "c", "d", "e"] }]);
        const unit = units.find((u): u is RailProductUnit => u.kind === "product");
        expect(productGridEntries(unit).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
        expect(productGridEntries({ ...unit, entries: unit.entries.slice(0, 2) }).map((e) => e.id)).toEqual(["a", "b"]);
    });

    it("draws the members in the rail's flow along a guide, never as a floating column", () => {
        const css = source("./moltenterm-shell.css");
        const members = cssRule(css, ".molten-rail-members");
        expect(members).not.toContain("position: fixed");
        expect(members).toContain("padding-left: 8px;");
        expect(cssRule(css, ".molten-rail-members::before")).toContain("width: 2px;");
        const grid = cssRule(css, ".molten-rail-group-grid");
        expect(grid).toContain("grid-template-columns: 1fr 1fr;");
        expect(grid).toContain("border: 1.5px solid");
        expect(source("./rail-product.tsx")).not.toContain("fa-chevron");
    });
});
