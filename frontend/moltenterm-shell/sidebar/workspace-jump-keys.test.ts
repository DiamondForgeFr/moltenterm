// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The top field's workspace rows show the workspace keys the menu binds: ⌥1…⌥9 on macOS (#1345), Ctrl+Alt+1…9
// elsewhere (#1379, FR-SHELL-108).

import { describe, expect, it } from "vitest";
import { formatKeys } from "../shortcuts/format";
import { workspaceJumpKeys } from "./sidebar-keys";

describe("workspace jump keys (#1379)", () => {
    it("shows ⌥n on macOS, never the old ⌃⌘n", () => {
        for (let n = 1; n <= 9; n++) {
            expect(formatKeys(workspaceJumpKeys(n, true), true)).toBe(`⌥${n}`);
        }
        expect(formatKeys(workspaceJumpKeys(1, true), true)).not.toContain("⌃⌘");
    });

    it("shows Ctrl+Alt+n elsewhere, as the Workspace menu binds it", () => {
        expect(formatKeys(workspaceJumpKeys(3, false), false)).toBe("Ctrl+Alt+3");
    });
});
