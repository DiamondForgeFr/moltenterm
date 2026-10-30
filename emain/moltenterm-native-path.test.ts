// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    register: null as any,
    openPath: vi.fn(async (_path: string) => ""),
    reveal: vi.fn((_path: string) => {}),
}));
vi.mock("electron", () => ({
    ipcMain: {},
    app: { getPath: () => "/Users/test" },
    shell: { openPath: mocks.openPath, showItemInFolder: mocks.reveal },
}));
vi.mock("./emain-platform", () => ({
    unamePlatform: "darwin",
    callWithOriginalXdgCurrentDesktopAsync: (fn: () => Promise<void>) => fn(),
}));
vi.mock("./moltenterm-privileged-ipc", async (original) => ({
    ...(await original<typeof import("./moltenterm-privileged-ipc")>()),
    onAppIpc: (...args: any[]) => mocks.register(...args),
}));

import { createPrivilegedIpc } from "./moltenterm-privileged-ipc";
import { expandNativeHome, initNativePathIpc } from "./moltenterm-native-path";

describe("native path IPC", () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const frame = {};
    const host = { mainFrame: frame };
    beforeEach(() => {
        listeners.clear();
        mocks.openPath.mockClear();
        mocks.reveal.mockClear();
        const ipc = createPrivilegedIpc({
            on: (channel: string, listener: any) => listeners.set(channel, listener),
            removeListener: () => {},
            handle: () => {},
        } as any, (event) => event.sender === host && event.senderFrame === frame);
        mocks.register = ipc.onApp;
        initNativePathIpc();
    });

    it("opens literal paths and expands only a leading home marker", async () => {
        const send = (path: string) => listeners.get("open-native-path")({ sender: host, senderFrame: frame }, path);
        send("/tmp/report~draft.docx");
        send("~/report~draft.docx");
        send("~");
        await vi.waitFor(() => expect(mocks.openPath).toHaveBeenCalledTimes(3));
        expect(mocks.openPath.mock.calls.map(([path]) => path)).toEqual([
            "/tmp/report~draft.docx", "/Users/test/report~draft.docx", "/Users/test",
        ]);
        expect(expandNativeHome("~\\docs\\x", "C:\\Users\\test", "win32")).toBe("C:\\Users\\test\\docs\\x");
        expect(expandNativeHome("~other/x", "/Users/test", "darwin")).toBe("~other/x");
        expect(expandNativeHome("~\\x", "/Users/test", "darwin")).toBe("~\\x");
    });

    it("reveals an executable without opening it, and refuses foreign or subframe callers", () => {
        const reveal = listeners.get("reveal-native-path");
        reveal({ sender: host, senderFrame: frame }, "/tmp/Example.app");
        expect(mocks.reveal).toHaveBeenCalledExactlyOnceWith("/tmp/Example.app");
        expect(mocks.openPath).not.toHaveBeenCalled();
        reveal({ sender: {}, senderFrame: frame }, "/tmp/other.app");
        reveal({ sender: host, senderFrame: {} }, "/tmp/other.app");
        listeners.get("open-native-path")({ sender: {}, senderFrame: frame }, "/tmp/other.app");
        expect(mocks.reveal).toHaveBeenCalledTimes(1);
        expect(mocks.openPath).not.toHaveBeenCalled();
    });
});
