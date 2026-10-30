// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    expose: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
}));
vi.mock("electron", () => ({
    contextBridge: { exposeInMainWorld: mocks.expose },
    ipcRenderer: { send: mocks.send, on: mocks.on },
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
});
