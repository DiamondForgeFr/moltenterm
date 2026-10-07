// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const { openCurrentWorkspaceEditor } = vi.hoisted(() => ({ openCurrentWorkspaceEditor: vi.fn() }));

vi.mock("@/app/store/global", () => ({}));
vi.mock("@/app/store/jotaiStore", () => ({}));
vi.mock("@/layout/index", () => ({}));
vi.mock("../../moltenterm-onboarding/onboarding-open", () => ({}));
vi.mock("../browser/browser-routing", () => ({}));
vi.mock("../open-view", () => ({}));
vi.mock("../project/project-tab", () => ({}));
vi.mock("../sessions/sessions-model", () => ({}));
vi.mock("../workspace-edit", () => ({ openCurrentWorkspaceEditor }));

import { runPaletteEntry } from "./palette-actions";

describe("palette Edit workspace… (FR-SHELL-030-AC3)", () => {
    it("opens the sheet of the workspace the window shows", async () => {
        await runPaletteEntry({ kind: "editworkspace" }, { placement: "new", blockId: null });
        expect(openCurrentWorkspaceEditor).toHaveBeenCalledOnce();
    });
});
