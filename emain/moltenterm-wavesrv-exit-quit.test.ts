// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Like Electron's BrowserWindow: once destroyed, every native accessor throws.
class FakeWindow extends EventEmitter {
    destroyed = false;
    nativeId: number;
    activeTabView: any;

    constructor(nativeId: number, tabContents: any) {
        super();
        this.nativeId = nativeId;
        this.activeTabView = { webContents: tabContents, getBounds: () => ({ x: 0, y: 0 }) };
    }

    get id(): number {
        this.assertLive();
        return this.nativeId;
    }

    assertLive() {
        if (this.destroyed) {
            throw new TypeError("Object has been destroyed");
        }
    }

    isDestroyed() {
        return this.destroyed;
    }

    isFocused() {
        this.assertLive();
        return true;
    }

    getContentBounds() {
        this.assertLive();
        return { x: 0, y: 0, width: 800, height: 600 };
    }

    // The order Electron follows when the app quits: "close", the native window goes, then "closed".
    quitClose() {
        this.emit("close", { preventDefault: () => {} });
        this.destroyed = true;
        this.emit("closed");
    }
}

const env = vi.hoisted(() => ({
    windows: [] as any[],
    contents: [] as any[],
    ipcHandlers: new Map<string, (...args: any[]) => void>(),
    spawned: [] as any[],
    quit: null as () => void,
}));

vi.mock("electron", () => ({
    app: { quit: () => env.quit() },
    ipcMain: { on: (channel: string, handler: (...args: any[]) => void) => env.ipcHandlers.set(channel, handler) },
    webContents: {
        fromId: (id: number) => env.contents.find((c) => c.id === id),
        getAllWebContents: () => env.contents,
    },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
}));
vi.mock("node:child_process", () => ({
    spawn: () => {
        const proc = new EventEmitter() as any;
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        env.spawned.push(proc);
        return proc;
    },
}));
vi.mock("../frontend/util/endpoints", () => ({ WebServerEndpointVarName: "WEB", WSServerEndpointVarName: "WS" }));
vi.mock("./authkey", () => ({ AuthKey: "key", WaveAuthKeyEnv: "AUTHKEY" }));
vi.mock("./emain-activity", () => ({ setForceQuit: vi.fn(), setUserConfirmedQuit: vi.fn() }));
vi.mock("./emain-platform", () => ({
    getElectronAppResourcesPath: () => "/res",
    getElectronAppUnpackedBasePath: () => "/app",
    getWaveConfigDir: () => "/config",
    getWaveDataDir: () => "/data",
    getWaveSrvCwd: () => "/data",
    getWaveSrvPath: () => "/bin/wavesrv",
    getXdgCurrentDesktop: () => null,
    WaveConfigHomeVarName: "CONFIG_HOME",
    WaveDataHomeVarName: "DATA_HOME",
}));
vi.mock("./emain-util", () => ({
    getElectronExecPath: () => "/electron",
    WaveAppElectronExecPath: "EXEC",
    WaveAppPathVarName: "APP",
    WaveAppResourcesPathVarName: "RES",
}));
vi.mock("./updater", () => ({ updater: null }));
vi.mock("./emain-window", () => ({
    getWaveWindowByWebContentsId: (id: number) => env.windows.find((w) => w.activeTabView.webContents.id === id),
}));
vi.mock("./emain-builder", () => ({ getBuilderWindowByWebContentsId: () => null }));

import { getIsWaveSrvDead, runWaveSrv } from "./emain-wavesrv";
import { initMoltentermContextMenu } from "./moltenterm-contextmenu";

function makeContents(id: number) {
    return {
        id,
        isDestroyed: () => false,
        getType: () => "window",
        getURL: () => "file:///index.html",
        on: () => {},
        once: () => {},
    };
}

initMoltentermContextMenu(async () => {});

describe("quit when wavesrv exits (#734)", () => {
    it("closes a window whose context menu was captured without touching it once destroyed", () => {
        const tab = makeContents(1);
        const win = new FakeWindow(10, tab);
        env.contents.push(tab);
        env.windows.push(win);
        const event = { sender: tab, returnValue: undefined as any };
        env.ipcHandlers.get("moltenterm-contextmenu-capture")(event, undefined);
        expect(event.returnValue).toEqual(expect.any(String));

        env.quit = vi.fn(() => {
            for (const w of env.windows) {
                w.quitClose();
            }
        });
        void runWaveSrv(() => {});
        const proc = env.spawned.at(-1);
        proc.emit("spawn");

        // The exit handler quits synchronously: a listener that throws on the destroyed window throws out of emit.
        expect(() => proc.emit("exit", 0)).not.toThrow();
        expect(env.quit).toHaveBeenCalledOnce();
        expect(win.isDestroyed()).toBe(true);
        expect(() => win.id).toThrow("Object has been destroyed");
        expect(getIsWaveSrvDead()).toBe(true);
    });
});
