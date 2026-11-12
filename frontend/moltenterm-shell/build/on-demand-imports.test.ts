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
        // What the layer draws loads the first time the mode opens, and the mode's model the first time it is needed;
        // the entry keeps only the watch (brainstorm-boot.ts).
        ["../brainstorm/brainstorm-layer.tsx", "./brainstorm-view"],
        ["../brainstorm/brainstorm-boot.ts", "./brainstorm-store"],
        // The questions about the folders load into his talk window the first time one is asked (#2248).
        ["../boss/brokk-talk.tsx", "../brainstorm/brainstorm-prompts"],
        // The brainstorm panel loads into his group the first time the mode opens (#2285).
        ["../boss/brokk-group.tsx", "../brainstorm/brainstorm-panel"],
        // The scripted replay's script and player load when the palette plays it (dev and local builds).
        ["../palette/palette-actions.ts", "../brainstorm/brainstorm-replay"],
    ])("%s imports %s on demand only", (file, mod) => {
        const text = source(file);
        expect(staticImports(text)).not.toContain(mod);
        expect(text).toContain(`import("${mod}")`);
    });

    // Read here, while the file is collected: collection has no timeout, and a loaded machine stretches this scan of
    // every source past a test's 5 s (#2274). The test below only reads the result.
    const threeOwners = shellSources().filter((file) => staticImports(readFileSync(file, "utf8")).some(isThree));

    // three.js comes only through the scene: no module the window loads up front imports it, and the entry guard of the
    // build refuses it in the entry chunk (entry-guard.ts HeavyPackages).
    it("three.js is imported by the brainstorm scene alone", () => {
        expect(threeOwners.map((file) => file.slice(file.indexOf("moltenterm-shell")))).toEqual([
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
