// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const { openCurrentWorkspaceEditor, openCard, refocusNode, focusedBlock } = vi.hoisted(() => ({
    openCurrentWorkspaceEditor: vi.fn(),
    openCard: vi.fn(),
    refocusNode: vi.fn(),
    focusedBlock: { id: null as string },
}));

vi.mock("@/app/store/global", () => ({ getFocusedBlockId: () => focusedBlock.id, refocusNode }));
vi.mock("@/app/store/jotaiStore", () => ({}));
vi.mock("@/layout/index", () => ({}));
vi.mock("../../moltenterm-onboarding/onboarding-open", () => ({}));
vi.mock("../boss/boss-store", () => ({ BossBubbleModel: { getInstance: () => ({ openCard }) } }));
vi.mock("../browser/browser-routing", () => ({}));
vi.mock("../open-view", () => ({}));
vi.mock("../project/project-tab", () => ({}));
// The close guard (FR-SHELL-061) names tabs as the tab bar does, through tab-identity, which reads this view's type.
vi.mock("../sessions/sessions-model", () => ({ MoltentermSessionsView: "molten-sessions" }));
vi.mock("../settings/settings-open", () => ({}));
vi.mock("../workspace-edit", () => ({ openCurrentWorkspaceEditor }));

import { runPaletteEntry } from "./palette-actions";

describe("palette Edit workspace… (FR-SHELL-030-AC3)", () => {
    it("opens the sheet of the workspace the window shows", async () => {
        await runPaletteEntry({ kind: "editworkspace" }, { placement: "new", blockId: null });
        expect(openCurrentWorkspaceEditor).toHaveBeenCalledOnce();
    });
});

describe("palette Show Ferrand's card (FR-BOSS-002-AC1)", () => {
    beforeEach(() => {
        openCard.mockReset();
        refocusNode.mockReset();
        focusedBlock.id = null;
    });

    it("shows the card and gives the focus back to the pane the palette came from", async () => {
        await runPaletteEntry({ kind: "bosscard" }, { placement: "new", blockId: "origin" });
        expect(openCard).toHaveBeenCalledOnce();
        const target = openCard.mock.calls[0][0];
        expect(target.isConnected).toBe(true);
        expect(refocusNode).not.toHaveBeenCalled();
        target.focus();
        expect(refocusNode).toHaveBeenCalledWith("origin");
    });

    it("gives it back to the pane the layout has focused when the palette was the sidebar's field", async () => {
        focusedBlock.id = "focused";
        await runPaletteEntry({ kind: "bosscard" }, { placement: "new", blockId: null });
        openCard.mock.calls[0][0].focus();
        expect(refocusNode).toHaveBeenCalledWith("focused");
    });

    it("leaves the card to remember the focus itself when no pane has it", async () => {
        await runPaletteEntry({ kind: "bosscard" }, { placement: "new", blockId: null });
        expect(openCard).toHaveBeenCalledWith(undefined);
    });
});
