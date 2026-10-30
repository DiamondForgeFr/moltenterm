// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    FoldMagnifyPx,
    FoldViewButtonsPx,
    type FoldableButton,
    foldHeader,
    headerFoldLevel,
    moreMenuEntries,
} from "./header-fold";

// A narrow panel folds its header from the right, never the close button (#1439). The folds live in container queries
// (CSS cannot read a constant), so the widths the "⋯" menus test in code must equal the ones the stylesheets use.
function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), "utf8");
}

function constant(source: string, name: string): number {
    const match = source.match(new RegExp(`const ${name} = (\\d+);`));
    expect(match, `${name} is declared`).not.toBeNull();
    return Number(match[1]);
}

function maxWidths(css: string): number[] {
    return [...css.matchAll(/@container [\w-]+ \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
}

describe("a narrow panel header folds in a stable order and keeps close", () => {
    it("the browser row's last fold is the width its menu tests", () => {
        const nav = constant(read("../browser/browser-view.tsx"), "FoldNavPx");
        const widths = maxWidths(read("../browser/browser.css"));
        expect(widths).toEqual([539, 439, nav - 1]);
        expect(widths).toEqual([...widths].sort((a, b) => b - a));
    });

    it("the panel header's title shrinks at the width its buttons fold", () => {
        const widths = maxWidths(read("./header.css"));
        expect(widths).toEqual([FoldViewButtonsPx - 1]);
    });

    // #1586: a stylesheet showed the "⋯" (and lost to Wave's header rules) while the menu was built from another
    // width; the header now takes the fold, the "⋯" and its rows from the same rule.
    it("the panel header decides its folds and its menu in one place", () => {
        const header = read("../../app/block/blockframe-header.tsx");
        expect(header).toContain("foldHeader(foldableDecls, foldLevel, canFoldMagnify)");
        expect(header).toContain("if (moreEntries.length > 0)");
        expect(header).not.toMatch(/molten-fold-/);
        expect(read("./header.css")).not.toMatch(/molten-fold-/);
    });

    it("close, the carpet button and the command panel trigger are never folded", () => {
        const css = [read("../browser/browser.css"), read("./header.css")].join("\n");
        const folded = [...css.matchAll(/\.molten-fold-[\w-]+/g)].map((m) => m[0]);
        expect(folded.length).toBeGreaterThan(0);
        const sources = [read("../browser/browser-view.tsx"), read("../../app/block/blockframe-header.tsx")].join("\n");
        for (const line of sources.split("\n")) {
            if (/molten-fold-/.test(line)) {
                expect(line).not.toMatch(/HeaderCloseButton|CarpetHeaderButton|command-panel-trigger/);
            }
        }
    });

    it("the carpet button stays shown in a panel that is not focused", () => {
        const css = read("../moltenterm-shell.css");
        expect(css).toMatch(/:not\(\.block-frame-default-close, \.mt-carpet-button, \.mt-pin-button\)/);
    });
});

describe("the header's fold rule decides the folds, the \"⋯\" and its menu (#1586)", () => {
    const view: FoldableButton = { icon: "eye", title: "Show hidden", click: () => {} };
    const drawn: FoldableButton = { icon: { drawn: true }, title: "Shell ready", noAction: true };
    const untitled: FoldableButton = { icon: "bug", click: () => {} };

    function menu(width: number, buttons: FoldableButton[], canFoldMagnify = true) {
        return moreMenuEntries(foldHeader(buttons, headerFoldLevel(width), canFoldMagnify));
    }

    it("folds nothing at a medium or wide width, nor before the header is measured: no \"⋯\"", () => {
        for (const width of [0, FoldViewButtonsPx, 670]) {
            const fold = foldHeader([view, drawn], headerFoldLevel(width), true);
            expect(fold.shown).toEqual([view, drawn]);
            expect(moreMenuEntries(fold)).toEqual([]);
        }
    });

    it("lists every folded button once the header is narrow, a drawn icon included without its icon", () => {
        const entries = menu(FoldViewButtonsPx - 1, [view, drawn]);
        expect(entries).toEqual([
            { kind: "button", button: view, label: "Show hidden", icon: "eye", enabled: true },
            { kind: "button", button: drawn, label: "Shell ready", icon: undefined, enabled: false },
        ]);
    });

    it("adds Magnify under its own width, only when the panel can magnify", () => {
        expect(menu(FoldMagnifyPx, [])).toEqual([]);
        expect(menu(FoldMagnifyPx - 1, [])).toEqual([{ kind: "magnify" }]);
        expect(menu(FoldMagnifyPx - 1, [], false)).toEqual([]);
        expect(foldHeader([], headerFoldLevel(FoldMagnifyPx - 1), true).foldMagnify).toBe(true);
    });

    it("keeps a button its menu row could not name in the header", () => {
        const fold = foldHeader([view, untitled], headerFoldLevel(200), false);
        expect(fold.shown).toEqual([untitled]);
        expect(moreMenuEntries(fold).map((e) => (e.kind === "button" ? e.label : e.kind))).toEqual(["Show hidden"]);
    });

    it("never shows a \"⋯\" whose menu is empty, at any width", () => {
        for (let width = 0; width <= 800; width += 5) {
            for (const buttons of [[], [view], [drawn], [untitled], [view, drawn, untitled]]) {
                for (const canFoldMagnify of [true, false]) {
                    const fold = foldHeader(buttons, headerFoldLevel(width), canFoldMagnify);
                    const folds = fold.folded.length > 0 || fold.foldMagnify;
                    expect(moreMenuEntries(fold).length > 0).toBe(folds);
                    expect(fold.shown.length + fold.folded.length).toBe(buttons.length);
                }
            }
        }
    });
});
