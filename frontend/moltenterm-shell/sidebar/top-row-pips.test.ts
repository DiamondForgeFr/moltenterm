// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Pilotage's pull request counts sit under its block, outside it (FR-SHELL-085, sidebar.css .mt-sb-pips): a top-row
// block that clipped its overflow kept their room and hid them (#1283).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = fs.readFileSync(path.join(__dirname, "workspace-sidebar.tsx"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "sidebar.css"), "utf8");

function topRowBlockSource(): string {
    const start = src.indexOf("function TopRowBlock(");
    expect(start).toBeGreaterThanOrEqual(0);
    return src.slice(start, src.indexOf("\n}\n", start));
}

describe("the top row's pull request counts (#1283)", () => {
    it("are drawn outside the block", () => {
        expect(css).toMatch(/\.mt-sb-pips\s*{[^}]*top:\s*calc\(100% \+ 3px\)/);
    });

    it("are not clipped by the block, whose glyph is clipped on its own", () => {
        const block = topRowBlockSource();
        const button = block.slice(block.indexOf("<button"), block.indexOf("<ViewGlyph"));
        expect(button).not.toMatch(/overflow-hidden/);
        expect(block).toContain(
            '<ViewGlyph icons={glyph} small={glyph.length > 1} className="max-w-full overflow-hidden" />'
        );
        expect(block).toContain("<PrPips");
    });
});
