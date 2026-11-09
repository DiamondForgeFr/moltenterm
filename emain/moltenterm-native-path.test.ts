// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    register: null as any,
    handle: null as any,
    resources: "/nowhere",
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
    getElectronAppResourcesPath: () => mocks.resources,
}));
vi.mock("./moltenterm-privileged-ipc", async (original) => ({
    ...(await original<typeof import("./moltenterm-privileged-ipc")>()),
    onAppIpc: (...args: any[]) => mocks.register(...args),
    handleAppIpc: (...args: any[]) => mocks.handle(...args),
}));

import { createPrivilegedIpc, IpcDeniedMessage } from "./moltenterm-privileged-ipc";
import {
    expandNativeHome,
    initNativePathIpc,
    openThirdPartyNotices,
    ThirdPartyNoticesChannel,
    thirdPartyNoticesPath,
} from "./moltenterm-native-path";

describe("native path IPC", () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const handlers = new Map<string, (...args: any[]) => any>();
    const frame = {};
    const host = { mainFrame: frame };
    beforeEach(() => {
        listeners.clear();
        handlers.clear();
        mocks.openPath.mockClear();
        mocks.reveal.mockClear();
        const ipc = createPrivilegedIpc({
            on: (channel: string, listener: any) => listeners.set(channel, listener),
            removeListener: () => {},
            handle: (channel: string, handler: any) => handlers.set(channel, handler),
        } as any, (event) => event.sender === host && event.senderFrame === frame);
        mocks.register = ipc.onApp;
        mocks.handle = ipc.handleApp;
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

    describe("third-party notices (#2126)", () => {
        const dirs: string[] = [];
        afterEach(() => {
            for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
            mocks.resources = "/nowhere";
        });

        function resourcesWithNotices(withFile = true): string {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-notices-ipc-"));
            dirs.push(dir);
            if (withFile) {
                fs.mkdirSync(path.join(dir, "licenses"));
                fs.writeFileSync(path.join(dir, "licenses", "THIRD-PARTY-NOTICES.txt"), "notices");
            }
            return dir;
        }
        const call = (event = { sender: host, senderFrame: frame }) => handlers.get(ThirdPartyNoticesChannel)(event);

        it("looks for the file where electron-builder ships it, and where a development build writes it", () => {
            expect(thirdPartyNoticesPath("/App/Contents/Resources")).toBe(
                path.join("/App/Contents/Resources", "licenses", "THIRD-PARTY-NOTICES.txt")
            );
            expect(ThirdPartyNoticesChannel).toBe("moltenterm-open-third-party-notices");
        });

        it("opens the shipped file with the system's viewer, whatever the renderer sends", async () => {
            mocks.resources = resourcesWithNotices();
            const opened = await handlers.get(ThirdPartyNoticesChannel)({ sender: host, senderFrame: frame }, "/etc/passwd");
            expect(opened).toBe(true);
            expect(mocks.openPath).toHaveBeenCalledExactlyOnceWith(
                path.join(mocks.resources, "licenses", "THIRD-PARTY-NOTICES.txt")
            );
        });

        it("answers false, and opens nothing, when the build holds no notices", async () => {
            mocks.resources = resourcesWithNotices(false);
            expect(await call()).toBe(false);
            expect(mocks.openPath).not.toHaveBeenCalled();
        });

        it("answers false when the system has no viewer for it", async () => {
            const resources = resourcesWithNotices();
            mocks.openPath.mockResolvedValueOnce("No application is associated");
            const error = vi.spyOn(console, "error").mockImplementation(() => {});
            expect(await openThirdPartyNotices(resources)).toBe(false);
            expect(error).toHaveBeenCalledTimes(1);
            error.mockRestore();
        });

        it("refuses a caller that is not the application's own window", () => {
            mocks.resources = resourcesWithNotices();
            expect(() => call({ sender: {} as any, senderFrame: frame })).toThrow(IpcDeniedMessage);
            expect(() => call({ sender: host, senderFrame: {} as any })).toThrow(IpcDeniedMessage);
            expect(mocks.openPath).not.toHaveBeenCalled();
        });
    });
});
