// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    FoldLabelsMaxPx,
    FoldLastMaxPx,
    FoldNavMaxPx,
    FoldPairMaxPx,
    menuPartsAt,
    rowFoldsAt,
    type MenuPart,
} from "./browser-row-folds";

// The web page panel's row (#2489, FR-BRW-025): its tools are shown at rest, only Share and Open in wait for the focus,
// and the row folds in four steps. The steps are container queries, so the stylesheet is read and evaluated at the
// widths the ticket names (1200, 620, 440 and 340 px) and at every width between; the "⋯" menu reads the same widths.
function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), "utf8");
}

const css = read("./browser.css");
const view = read("./browser-view.tsx");
const shellCss = read("../moltenterm-shell.css");

type Rule = { selector: string; display: string | null; faded: boolean };

function blockEnd(source: string, open: number): number {
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === "{") {
            depth++;
        } else if (source[i] === "}" && --depth === 0) {
            return i;
        }
    }
    return source.length;
}

function holds(condition: string, width: number): boolean {
    return [...condition.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, kind, px]) =>
        kind === "min" ? width >= Number(px) : width <= Number(px)
    );
}

// The rules of the row's container queries that hold at this width.
function rulesAt(width: number): Rule[] {
    const rules: Rule[] = [];
    for (const query of css.matchAll(/@container molten-browser-row ([^{]+)\{/g)) {
        if (!holds(query[1], width)) {
            continue;
        }
        const open = query.index + query[0].length - 1;
        const body = css.slice(open + 1, blockEnd(css, open));
        for (const rule of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            const decls = rule[2];
            rules.push({
                selector: rule[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(),
                display: decls.match(/display:\s*([\w-]+)/)?.[1] ?? null,
                faded: /opacity:\s*0;/.test(decls) && /pointer-events:\s*none/.test(decls),
            });
        }
    }
    return rules;
}

type Drawn = {
    hidden: Set<string>;
    moreShown: boolean;
    moreFadedAtRest: boolean;
    wordHidden: boolean;
};

function drawnAt(width: number): Drawn {
    const rules = rulesAt(width);
    const hidden = new Set<string>();
    for (const rule of rules) {
        const fold = rule.selector.match(/^\.molten-browser-row \.(molten-fold-\d)$/)?.[1];
        if (fold != null && rule.display === "none") {
            hidden.add(fold);
        }
    }
    const more = rules.filter((rule) => rule.selector.endsWith(".molten-fold-more"));
    return {
        hidden,
        moreShown: more.some((rule) => rule.display === "flex"),
        moreFadedAtRest: more.some((rule) => rule.faded),
        wordHidden: rules.some(
            (rule) => rule.selector === ".molten-browser-row .molten-conn-word" && rule.display === "none"
        ),
    };
}

const Folds = ["molten-fold-1", "molten-fold-2", "molten-fold-3", "molten-fold-4"];

describe("the browser row's folds (#2489, FR-BRW-025 AC4)", () => {
    it("takes its four widths from browser-row-folds.ts, widest first", () => {
        const widths = [...css.matchAll(/@container molten-browser-row \(max-width: (\d+)px\)/g)].map((m) =>
            Number(m[1])
        );
        expect(widths).toEqual([FoldLabelsMaxPx, FoldPairMaxPx, FoldNavMaxPx, FoldLastMaxPx]);
        expect(widths).toEqual([...widths].sort((a, b) => b - a));
    });

    it('folds nothing at 1200 and 620 px, and the "⋯" is not there', () => {
        for (const width of [1200, 620]) {
            const drawn = drawnAt(width);
            expect([...drawn.hidden]).toEqual([]);
            expect(drawn.moreShown).toBe(false);
            expect(drawn.wordHidden).toBe(false);
        }
    });

    // The add-bookmark button (#2531) took 28 px from the host's name, so each step starts 28 px wider than the ticket's
    // 540, 440, 400 and 350.
    it("loses the labels, and the connection word, from 567 px down, and still shows Share and Open in", () => {
        for (const width of [FoldLabelsMaxPx, 520, FoldPairMaxPx + 1]) {
            const drawn = drawnAt(width);
            expect([...drawn.hidden]).toEqual(["molten-fold-1"]);
            expect(drawn.wordHidden).toBe(true);
            expect(drawn.moreShown).toBe(false);
        }
        expect(drawnAt(FoldLabelsMaxPx + 1).wordHidden).toBe(false);
    });

    it('moves Share and Open in into the "⋯" from 467 px down, which then follows their focus rule', () => {
        for (const width of [FoldPairMaxPx, 450, FoldNavMaxPx + 1]) {
            const drawn = drawnAt(width);
            expect([...drawn.hidden].sort()).toEqual(["molten-fold-1", "molten-fold-2"]);
            expect(drawn.moreShown).toBe(true);
            expect(drawn.moreFadedAtRest).toBe(true);
        }
    });

    it('moves Forward and Maximize from 427 px down, and the "⋯" is then shown at rest; Reload, the add button and Bookmarks stay', () => {
        for (const width of [FoldNavMaxPx, 400, 390, FoldLastMaxPx + 1]) {
            const drawn = drawnAt(width);
            expect([...drawn.hidden].sort()).toEqual(["molten-fold-1", "molten-fold-2", "molten-fold-3"]);
            expect(drawn.moreShown).toBe(true);
            expect(drawn.moreFadedAtRest).toBe(false);
        }
    });

    it("moves Reload, the add button and Bookmarks last, from 377 px down, 340 px included", () => {
        for (const width of [FoldLastMaxPx, 340, 300, 280]) {
            const drawn = drawnAt(width);
            expect([...drawn.hidden].sort()).toEqual(Folds);
            expect(drawn.moreShown).toBe(true);
            expect(drawn.moreFadedAtRest).toBe(false);
        }
    });

    it('agrees with the module the "⋯" menu reads at every width', () => {
        for (let width = 200; width <= 700; width++) {
            const drawn = drawnAt(width);
            const folds = rowFoldsAt(width);
            expect(drawn.hidden.has("molten-fold-1"), `${width} px, labels`).toBe(folds.labels);
            expect(drawn.hidden.has("molten-fold-2"), `${width} px, pair`).toBe(folds.pair);
            expect(drawn.hidden.has("molten-fold-3"), `${width} px, nav`).toBe(folds.nav);
            expect(drawn.hidden.has("molten-fold-4"), `${width} px, last`).toBe(folds.last);
            expect(drawn.moreShown, `${width} px, more`).toBe(folds.pair);
            expect(drawn.moreFadedAtRest, `${width} px, more faded`).toBe(folds.pair && !folds.nav);
        }
    });

    it("lists in the menu exactly what the row folded, never what it still shows", () => {
        const folded: Record<MenuPart, string> = {
            forward: "molten-fold-3",
            maximize: "molten-fold-3",
            reload: "molten-fold-4",
            bookmarkPage: "molten-fold-4",
            bookmarks: "molten-fold-4",
            share: "molten-fold-2",
            engine: "molten-fold-2",
            copyLink: "molten-fold-2",
        };
        for (const width of [1200, 620, 520, 467, 450, 428, 427, 400, 378, 377, 340, 300]) {
            const parts = menuPartsAt(width);
            const hidden = drawnAt(width).hidden;
            for (const [part, fold] of Object.entries(folded)) {
                if (part === "copyLink") {
                    continue;
                }
                expect(parts.includes(part as MenuPart), `${part} at ${width} px`).toBe(hidden.has(fold));
            }
        }
    });

    it("builds the menu in the order the row folds, at the ticket's widths", () => {
        expect(menuPartsAt(1200)).toEqual([]);
        expect(menuPartsAt(620)).toEqual([]);
        expect(menuPartsAt(FoldPairMaxPx + 1)).toEqual([]);
        expect(menuPartsAt(450)).toEqual(["copyLink", "share", "engine"]);
        expect(menuPartsAt(400)).toEqual(["forward", "maximize", "copyLink", "share", "engine"]);
        const all = ["forward", "reload", "bookmarkPage", "maximize", "copyLink", "bookmarks", "share", "engine"];
        expect(menuPartsAt(340)).toEqual(all);
        expect(menuPartsAt(300)).toEqual(all);
    });
});

function between(source: string, from: string, to: string): string {
    const start = source.indexOf(from);
    expect(start, `${from} is in the source`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(to, start + from.length);
    return source.slice(start, end < 0 ? undefined : end);
}

function inOrder(source: string, markers: string[]): void {
    let at = -1;
    for (const marker of markers) {
        const found = source.indexOf(marker, at + 1);
        expect(found, `${marker} comes after the previous one`).toBeGreaterThan(at);
        at = found;
    }
}

describe("the browser row's controls and their order (#2489, FR-BRW-025 AC1 to AC3)", () => {
    const bar = between(view, "function BrowserNavBar(", "// The annotate layers over the panel's pages");
    const buttons = between(view, "function BrowserPanelButtons(", "// The page's site in the panel's row");

    it("draws Back, Forward, Comment, Reload, the connection button and the host on the left", () => {
        inOrder(bar, [
            '"arrow-left"',
            '"arrow-right"',
            "<CommentButton",
            '"rotate-right"',
            "<BookmarkAddButton",
            "<TestContextChip",
            "<ConnectionControl",
            "<PageAddress",
        ]);
    });

    it("draws the add-bookmark button directly after Reload (and Stop), folding with them, last (#2531)", () => {
        const afterReload = between(bar, '"rotate-right"', "<TestContextChip");
        expect(afterReload).toContain("<BookmarkAddButton");
        expect(between(afterReload, "<BookmarkAddButton", "/>")).toContain('className="molten-fold-4"');
    });

    it("keeps Back, Comment, Reload and the add button out of every focus-only group; they fold last", () => {
        const left = between(bar, '"arrow-left"', '<span className="mt-focus-only molten-fold-2');
        expect(left).not.toContain("mt-focus-only");
        expect(left).toContain('"molten-fold-3"');
        // Stop and Reload, then the add button, which folds with them.
        expect(left.match(/"molten-fold-4"/g)).toHaveLength(3);
    });

    it("draws Share and Open in to the left of the end icons, in the only focus-only group but the test chip", () => {
        const tools = between(bar, 'data-testid="browser-focus-tools"', "</span>");
        expect(tools).toContain("<ShareButton");
        expect(tools).toContain("<EngineButton");
        expect(tools).not.toContain("<BookmarksPanelButton");
        const group = between(bar, '<span\n                className="mt-focus-only', ">");
        expect(group).toContain("molten-fold-2");
        expect([...bar.matchAll(/mt-focus-only/g)]).toHaveLength(2);
        inOrder(bar, ["<ShareButton", "<EngineButton", 'data-testid="browser-more"', "<BrowserPanelButtons"]);
    });

    it('gives the "⋯" no focus rule of its own in the markup: the stylesheet decides when it fades', () => {
        const more = between(bar, 'data-testid="browser-more"', "</button>");
        expect(more).toContain("molten-fold-more");
        expect(more).not.toContain("mt-focus-only");
    });

    it("draws the bookmarks panel button, the 360 view button, settings, Maximize and Close on the right, in this order, shown at rest", () => {
        inOrder(buttons, [
            "<BookmarksPanelButton",
            "<CarpetHeaderButton",
            'data-role="command-panel-trigger"',
            "<OptMagnifyButton",
            "<HeaderCloseButton",
        ]);
        expect(buttons).not.toContain("mt-focus-only");
        expect(between(buttons, "<BookmarksPanelButton", "/>")).toContain('className="molten-fold-4"');
        expect(buttons).toMatch(/!magnified && "molten-fold-3"/);
    });

    it("never folds close, the 360 view button, the settings or the connection button", () => {
        for (const line of view.split("\n")) {
            if (/molten-fold-\d/.test(line)) {
                expect(line).not.toMatch(
                    /HeaderCloseButton|CarpetHeaderButton|command-panel-trigger|ConnectionControl/
                );
            }
        }
        expect(css).not.toMatch(/molten-conn(?!-word)[^{]*\{[^}]*display:\s*none/);
    });

    it("fades only the focus-only tools of the row, and brings them back with the pointer or the keyboard focus", () => {
        const fade = between(shellCss, ".block.block-frame-default:not(.block-focused)\n    .mt-focus-only", "}");
        expect(fade).toContain(".molten-browser-row:is(:hover, :focus-within) .mt-focus-only");
        expect(fade).toContain("opacity: 0;");
        expect(fade).toContain("pointer-events: none;");
        expect(shellCss).not.toMatch(/molten-browser-panel-buttons[^{]*\{[^}]*opacity/);
    });
});
