// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// FR-SHELL-054, DS-SHELL-096: a Mission Control dialog dims the app with the shared scrim, never a backdrop of its own.
describe("Mission Control dialog backdrops", () => {
    // Scanned while the file is collected, not in the test: collection has no timeout, and a loaded machine stretches
    // this scan of the folder past a test's 5 s (#2496).
    const ownBackdrops: string[] = [];
    for (const file of readdirSync(__dirname)) {
        if (!file.endsWith(".tsx") || file.endsWith(".test.tsx")) {
            continue;
        }
        readFileSync(join(__dirname, file), "utf8")
            .split("\n")
            .forEach((line, i) => {
                if (line.includes("fixed inset-0") && !line.includes("ScrimClass")) {
                    ownBackdrops.push(`${file}:${i + 1}`);
                }
            });
    }

    it("every full-screen overlay uses ScrimClass", () => {
        expect(ownBackdrops).toEqual([]);
    });
});
