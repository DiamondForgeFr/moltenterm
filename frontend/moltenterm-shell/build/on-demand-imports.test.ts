// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

function source(name: string): string {
    return readFileSync(new URL(name, import.meta.url), "utf8");
}

function staticImports(text: string): string[] {
    return [...text.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
}

// Code shown only on demand stays behind a dynamic import, out of the JS every tab view loads up front (NFR-PERF-003,
// bundle.initialJsMB). One static import from the entry graph brings it back, and the bundle budget turns red (#2200).
describe("on-demand modules stay out of the entry chunk (#2200)", () => {
    it.each([
        ["../reviews/reviews-launch.tsx", "./reviews-launch-dialogs"],
        ["../reviews/reviews-owners.tsx", "./reviews-owners-menu"],
        ["../view360/view360-carpet.tsx", "./view360-offer-card"],
        ["../../molten/molten-start.ts", "./molten-validate"],
    ])("%s imports %s on demand only", (file, mod) => {
        const text = source(file);
        expect(staticImports(text)).not.toContain(mod);
        expect(text).toContain(`import("${mod}")`);
    });
});
