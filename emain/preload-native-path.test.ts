// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    expose: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    invoke: vi.fn(),
}));
vi.mock("electron", () => ({
    contextBridge: { exposeInMainWorld: mocks.expose },
    ipcRenderer: { send: mocks.send, on: mocks.on, invoke: mocks.invoke },
    webUtils: {},
}));

import "./preload";

describe("native path preload", () => {
    it("sends reveal on its own IPC channel", () => {
        const api = mocks.expose.mock.calls.find(([name]) => name === "api")?.[1];
        expect(api).toBeTruthy();
        api.revealNativePath("/tmp/Example.app");
        expect(mocks.send).toHaveBeenCalledExactlyOnceWith("reveal-native-path", "/tmp/Example.app");
    });

    it("asks main to open the third-party notices without naming a path (#2126)", async () => {
        const api = mocks.expose.mock.calls.find(([name]) => name === "api")?.[1];
        mocks.invoke.mockResolvedValueOnce(true);
        await expect(api.openThirdPartyNotices()).resolves.toBe(true);
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("moltenterm-open-third-party-notices");
    });
});
