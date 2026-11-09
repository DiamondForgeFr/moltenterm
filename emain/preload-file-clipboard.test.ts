// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    expose: vi.fn(),
    invoke: vi.fn(async (..._args: any[]) => "copied"),
    send: vi.fn(),
    on: vi.fn(),
}));
vi.mock("electron", () => ({
    contextBridge: { exposeInMainWorld: mocks.expose },
    ipcRenderer: { invoke: mocks.invoke, send: mocks.send, on: mocks.on },
    webUtils: {},
}));

import "./preload";

describe("file clipboard preload", () => {
    it("asks the main process on its own channel and sends no event", async () => {
        const api = mocks.expose.mock.calls.find(([name]) => name === "api")?.[1];
        expect(api).toBeTruthy();
        expect(await api.copyFileToClipboard("/tmp/sample.md")).toBe("copied");
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("moltenterm-copy-file", "/tmp/sample.md");
        expect(mocks.send).not.toHaveBeenCalled();
    });
});
