// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { statusBarMarker, TreeMarker } from "../worktree-model";

// The sidebar's status line is the window's status bar while the sidebar is on (#1293): its tree chip follows the
// status bar's rule (#1262), the main tree says nothing, a worktree keeps its chip.
describe("the sidebar's status line chip (DS-SHELL-127, #1293)", () => {
    it("shows no chip for the main tree and keeps a worktree's", () => {
        expect(statusBarMarker({ kind: "main", label: "main tree" } as TreeMarker)).toBeNull();
        const wt = { kind: "worktree", label: "wt-1" } as TreeMarker;
        expect(statusBarMarker(wt)).toBe(wt);
    });

    it("passes every status chip, in the sidebar and in the status bar, through statusBarMarker", () => {
        for (const file of ["./workspace-sidebar.tsx", "../status-bar.tsx"]) {
            const source = readFileSync(new URL(file, import.meta.url), "utf8");
            const chips = source.match(/<WorktreeChip marker=\{[^}]*\}/g) ?? [];
            expect(chips.length, file).toBeGreaterThan(0);
            for (const chip of chips) {
                expect(chip, file).toMatch(/marker=\{statusBarMarker\(/);
            }
        }
    });
});
