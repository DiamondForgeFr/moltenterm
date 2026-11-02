// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// #1009: a modal's scrim covers the whole window; a backdrop-filter there is a full-window read-back on every frame the
// modal stays open, and the app flashed through open modals on the built-in variable-refresh display.
function ruleBody(css: string, selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
        if (css[i] === "{") {
            depth++;
        } else if (css[i] === "}") {
            depth--;
            if (depth === 0) {
                return css.slice(start, i + 1);
            }
        }
    }
    throw new Error(`${selector} rule is not closed`);
}

describe("modal scrims", () => {
    it("MoltenTerm's scrim dims without a backdrop filter", () => {
        const css = readFileSync(join(__dirname, "tokens.css"), "utf8");
        const body = ruleBody(css, ".molten-scrim");
        expect(body).toContain("background: var(--mt-scrim)");
        expect(body).not.toContain("backdrop-filter");
    });

    it("Wave's modal backdrop dims without a backdrop filter", () => {
        const scss = readFileSync(join(__dirname, "../app/modals/modal.scss"), "utf8");
        const body = ruleBody(scss, ".modal-backdrop");
        expect(body).toContain("background-color: var(--mt-scrim)");
        expect(body).not.toContain("backdrop-filter");
    });
});
