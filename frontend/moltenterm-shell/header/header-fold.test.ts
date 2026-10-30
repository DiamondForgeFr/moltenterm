// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

    it("the panel header's magnify fold is the width its menu tests", () => {
        const magnify = constant(read("../../app/block/blockframe-header.tsx"), "FoldMagnifyPx");
        const widths = maxWidths(read("./header.css"));
        expect(widths).toEqual([339, magnify - 1]);
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
