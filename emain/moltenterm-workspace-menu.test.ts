// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import {
    makeMoltentermEditWorkspaceMenuItem,
    MoltentermEditWorkspaceChannel,
    MoltentermEditWorkspaceMenuId,
} from "./moltenterm-workspace-menu";

function target(destroyed = false) {
    return { send: vi.fn(), isDestroyed: () => destroyed } as any;
}

function click(item: Electron.MenuItemConstructorOptions, window: unknown) {
    (item.click as any)(null, window, null);
}

describe("Workspace › Edit Workspace… (FR-SHELL-030-AC3)", () => {
    it("is an item with a stable id", () => {
        const item = makeMoltentermEditWorkspaceMenuItem(() => null);
        expect(item.id).toBe(MoltentermEditWorkspaceMenuId);
        expect(item.label).toBe("Edit Workspace…");
    });

    it("asks the active tab of the window it was used from to open the sheet", () => {
        const tab = target();
        const window = { id: 1 };
        const targetOf = vi.fn(() => tab);
        click(makeMoltentermEditWorkspaceMenuItem(targetOf), window);
        expect(targetOf).toHaveBeenCalledWith(window);
        expect(tab.send).toHaveBeenCalledExactlyOnceWith(MoltentermEditWorkspaceChannel);
    });

    it("does nothing without a live tab, never an error", () => {
        expect(() =>
            click(
                makeMoltentermEditWorkspaceMenuItem(() => null),
                null
            )
        ).not.toThrow();
        const gone = target(true);
        click(
            makeMoltentermEditWorkspaceMenuItem(() => gone),
            {}
        );
        expect(gone.send).not.toHaveBeenCalled();
    });

    it("matches the channel the preload listens on", async () => {
        const { readFileSync } = await import("node:fs");
        const preload = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
        expect(preload).toContain(`ipcRenderer.on("${MoltentermEditWorkspaceChannel}"`);
        const menu = readFileSync(new URL("./emain-menu.ts", import.meta.url), "utf8");
        expect(menu).toMatch(/label: "Create Workspace",[\s\S]*?makeMoltentermEditWorkspaceMenuItem\(/);
    });
});
