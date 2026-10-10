// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// FR-SHELL-054, DS-SHELL-096: a Mission Control dialog dims the app with the shared scrim, never a backdrop of its own.
describe("Mission Control dialog backdrops", () => {
    it("every full-screen overlay uses ScrimClass", () => {
        const offenders: string[] = [];
        for (const file of readdirSync(__dirname)) {
            if (!file.endsWith(".tsx") || file.endsWith(".test.tsx")) {
                continue;
            }
            readFileSync(join(__dirname, file), "utf8")
                .split("\n")
                .forEach((line, i) => {
                    if (line.includes("fixed inset-0") && !line.includes("ScrimClass")) {
                        offenders.push(`${file}:${i + 1}`);
                    }
                });
        }
        expect(offenders).toEqual([]);
    });
});
