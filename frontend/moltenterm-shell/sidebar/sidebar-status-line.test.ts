// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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

    it("draws the separator above the bottom bar in the docked sidebar only, with the line token (#1401)", () => {
        const source = readFileSync(new URL("./workspace-sidebar.tsx", import.meta.url), "utf8");
        expect(source).toMatch(/!hidden && "border-t border-line pt-1\.5"[\s\S]{0,80}sidebar-bottom-bar/);
    });

    it("passes every status chip, in the status bar and in the panel headers, through statusBarMarker", () => {
        const bar = readFileSync(new URL("../status-bar.tsx", import.meta.url), "utf8");
        const chips = bar.match(/<WorktreeChip marker=\{[^}]*\}/g) ?? [];
        expect(chips.length).toBeGreaterThan(0);
        for (const chip of chips) {
            expect(chip).toMatch(/marker=\{statusBarMarker\(/);
        }
        const headerModel = readFileSync(new URL("../header/header-model.ts", import.meta.url), "utf8");
        expect(headerModel).toMatch(/const chip = statusBarMarker\(input\.marker\)/);
    });

    // #2476 (FR-SHELL-159, FR-SHELL-160): the branch, CI and pull request moved into the panels' headers, and the
    // ribbon took the line's left.
    it("draws no branch line any more: the context's ribbon is on its left, the build badge on its right", () => {
        const source = readFileSync(new URL("./workspace-sidebar.tsx", import.meta.url), "utf8");
        expect(source).not.toMatch(/BranchSection|sidebar-branch|useFocusedPane/);
        expect(source).toMatch(/data-testid="sidebar-status-line"[\s\S]{0,200}<ContextRibbonHost mode="sidebar"/);
        expect(source).toMatch(/data-testid="build-badge"/);
    });
});
