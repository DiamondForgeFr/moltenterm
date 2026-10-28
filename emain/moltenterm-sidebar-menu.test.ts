// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ meta: {} as Record<string, unknown>, set: vi.fn() }));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetMetaCommand: async () => rpc.meta,
        SetMetaCommand: async (_client: unknown, data: unknown) => rpc.set(data),
    },
}));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: {} }));
vi.mock("./moltenterm-i18n", () => ({ mt: (key: string) => key }));

import { makeMoltentermSidebarMenuItem, toggleWindowSidebar } from "./moltenterm-sidebar-menu";

describe("View › Show or hide the sidebar (#1279)", () => {
    it("is offered while the workspace sidebar is on", () => {
        const item = makeMoltentermSidebarMenuItem({}, () => "w1");
        expect(item?.label).toBe("appMenu.toggleSidebar");
        expect(item?.accelerator).toBeUndefined();
        expect(makeMoltentermSidebarMenuItem({ "shell:workspacesidebar": false }, () => "w1")).toBeNull();
    });

    it("flips the window's hidden flag", async () => {
        rpc.set.mockClear();
        rpc.meta = { "molten:sidebarhidden": true };
        await toggleWindowSidebar("w1");
        expect(rpc.set).toHaveBeenCalledWith({ oref: "window:w1", meta: { "molten:sidebarhidden": false } });
        rpc.meta = {};
        await toggleWindowSidebar("w1");
        expect(rpc.set).toHaveBeenLastCalledWith({ oref: "window:w1", meta: { "molten:sidebarhidden": true } });
    });

    it("does nothing without a window", async () => {
        rpc.set.mockClear();
        await toggleWindowSidebar("");
        expect(rpc.set).not.toHaveBeenCalled();
    });
});
