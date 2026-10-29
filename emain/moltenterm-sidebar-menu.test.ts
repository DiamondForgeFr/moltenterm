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

import { electronAccelerator } from "../frontend/moltenterm-shell/shortcuts/format";
import { findShortcut } from "../frontend/moltenterm-shell/shortcuts/registry";
import { makeMoltentermSidebarMenuItem, toggleWindowSidebar } from "./moltenterm-sidebar-menu";

describe("View › Show or hide the sidebar (#1279)", () => {
    it("is offered while the workspace sidebar is on", () => {
        const item = makeMoltentermSidebarMenuItem({}, () => "w1", "darwin");
        expect(item?.label).toBe("appMenu.toggleSidebar");
        expect(makeMoltentermSidebarMenuItem({ "shell:workspacesidebar": false }, () => "w1", "darwin")).toBeNull();
    });

    it("shows the registry's ⌘S, leaving the key to the page (#1325)", () => {
        expect(findShortcut("toggle-sidebar")?.keys).toBe("Cmd:s");
        expect(makeMoltentermSidebarMenuItem({}, () => "w1", "darwin")?.accelerator).toBe(
            electronAccelerator("Cmd:s", true)
        );
        const linux = makeMoltentermSidebarMenuItem({}, () => "w1", "linux");
        expect(linux?.accelerator).toBe(electronAccelerator("Cmd:s", false));
        expect(linux?.registerAccelerator).toBe(false);
        rpc.set.mockClear();
        (linux.click as any)(null, {}, { triggeredByAccelerator: true });
        expect(rpc.set).not.toHaveBeenCalled();
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
