// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

function source(name: string): string {
    return readFileSync(new URL(name, import.meta.url), "utf8");
}

function staticImports(text: string): string[] {
    return [...text.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
}

// Code shown only on demand stays behind a dynamic import, out of the JS every tab view loads up front (NFR-PERF-003,
// bundle.initialJsMB). One static import from the entry graph brings it back, and the bundle budget turns red (#2200).
describe("on-demand modules stay out of the entry chunk (#2200)", () => {
    it.each([
        ["../reviews/reviews-launch.tsx", "./reviews-launch-dialogs"],
        ["../reviews/reviews-owners.tsx", "./reviews-owners-menu"],
        ["../view360/view360-carpet.tsx", "./view360-offer-card"],
        ["../../molten/molten-start.ts", "./molten-validate"],
        // Brokk's thought in 3D (FR-BOSS-010 AC19, NFR-BOSS-009, #2246): three.js and the scene load when the mode first
        // opens, never with the window.
        ["../brainstorm/brainstorm-stage.tsx", "./brainstorm-scene"],
        // The scripted replay's script and player load when the palette plays it (dev and local builds).
        ["../palette/palette-actions.ts", "../brainstorm/brainstorm-replay"],
    ])("%s imports %s on demand only", (file, mod) => {
        const text = source(file);
        expect(staticImports(text)).not.toContain(mod);
        expect(text).toContain(`import("${mod}")`);
    });

    // three.js comes only through the scene: no module the window loads up front imports it, and the entry guard of the
    // build refuses it in the entry chunk (entry-guard.ts HeavyPackages).
    it("three.js is imported by the brainstorm scene alone", () => {
        const owners = shellSources().filter((file) => staticImports(readFileSync(file, "utf8")).some(isThree));
        expect(owners.map((file) => file.slice(file.indexOf("moltenterm-shell")))).toEqual([
            "moltenterm-shell/brainstorm/brainstorm-scene.ts",
        ]);
    });
});

function isThree(mod: string): boolean {
    return mod === "three" || mod.startsWith("three/");
}

function shellSources(): string[] {
    const root = fileURLToPath(new URL("..", import.meta.url));
    return (readdirSync(root, { recursive: true }) as string[])
        .filter((rel) => /\.(ts|tsx)$/.test(rel) && !/\.test\.tsx?$/.test(rel))
        .map((rel) => join(root, rel));
}
