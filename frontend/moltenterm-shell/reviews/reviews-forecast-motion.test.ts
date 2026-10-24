// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const Css = readFileSync(fileURLToPath(new URL("./reviews-forecast.css", import.meta.url)), "utf8");

function rule(selector: string): string {
    const start = Css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return Css.slice(start, Css.indexOf("}", start));
}

// #1059: the conflict lines looped forever while a row stayed selected, behind the batch merge dialog too.
describe("conflict forecast lines' motion (#1059)", () => {
    it("never loops", () => {
        expect(Css).not.toMatch(/infinite/);
    });

    it("draws each line once, then leaves it still", () => {
        const link = rule(".mt-forecast-link");
        expect(link).toMatch(/animation:\s*mt-forecast-draw\s+300ms\s+[^;]*\s1\s+backwards;/);
        expect(link).toMatch(/stroke-dashoffset:\s*0;/);
    });
});
