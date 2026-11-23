// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

// Read from disk: vitest stubs stylesheet imports.
const frontendDir = fileURLToPath(new URL("../", import.meta.url));
const appScss = readFileSync(join(frontendDir, "app", "app.scss"), "utf8");

function styleFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            return styleFiles(path);
        }
        return /\.(s?css)$/.test(name) ? [path] : [];
    });
}

// FR-SHELL-120 AC4 (#1917).
describe("panels show no scrollbar (FR-SHELL-120 AC4)", () => {
    // Scanned while the file is collected, not in the test: collection has no timeout, and a loaded machine stretches
    // this whole-tree scan past a test's 5 s (#2496).
    const visibleScrollbars = styleFiles(frontendDir)
        .filter((path) => !path.includes("node_modules"))
        .flatMap((path) =>
            [...readFileSync(path, "utf8").matchAll(/scrollbar-width:\s*([a-z]+)/g)]
                .filter((m) => m[1] !== "none")
                .map((m) => `${path}: ${m[0]}`)
        );

    it("hides native scrollbars everywhere but the terminal's viewport, at zero specificity", () => {
        expect(appScss).toMatch(/:where\(\*:not\(\.xterm-viewport\)\)\s*\{\s*scrollbar-width:\s*none;\s*\}/);
    });

    it("hides the OverlayScrollbars handles", () => {
        expect(appScss).toMatch(/\.os-scrollbar\s*\{\s*display:\s*none;\s*\}/);
    });

    it("lets no stylesheet bring a visible scrollbar back", () => {
        expect(visibleScrollbars).toEqual([]);
    });
});
