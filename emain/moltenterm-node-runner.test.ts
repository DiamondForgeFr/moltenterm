// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
    isPackaged: false,
    spawnedEnv: [] as Record<string, string>[],
}));

vi.mock("electron", () => ({
    app: {
        quit: () => {},
        get isPackaged() {
            return env.isPackaged;
        },
    },
}));
vi.mock("node:child_process", () => ({
    spawn: (_cmd: string, opts: { env: Record<string, string> }) => {
        env.spawnedEnv.push(opts.env);
        const proc = new EventEmitter() as any;
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        return proc;
    },
}));
vi.mock("../frontend/util/endpoints", () => ({ WebServerEndpointVarName: "WEB", WSServerEndpointVarName: "WS" }));
vi.mock("./authkey", () => ({
    AuthKey: "key",
    WaveAuthKeyEnv: "AUTHKEY",
    CallerSecret: "proof-secret",
    AppOrigin: "",
}));
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
    getElectronExecPath: () => "/Applications/MoltenTerm.app/Contents/MacOS/MoltenTerm",
    WaveAppElectronExecPath: "EXEC",
    WaveAppPathVarName: "APP",
    WaveAppResourcesPathVarName: "RES",
}));
vi.mock("./updater", () => ({ updater: null }));

import { runWaveSrv } from "./emain-wavesrv";
import { electronBinaryToRunAsNode } from "./moltenterm-node-runner";

describe("the Electron binary that runs Node.js scripts (#1975)", () => {
    it("is the app's own binary in a dev run, whose fuses are Electron's defaults", () => {
        expect(electronBinaryToRunAsNode("/dev/electron", false)).toBe("/dev/electron");
    });

    it("is none in a packaged app, whose runAsNode fuse is off", () => {
        expect(electronBinaryToRunAsNode("/Applications/MoltenTerm.app/Contents/MacOS/MoltenTerm", true)).toBe("");
    });

    it("is what wavesrv gets in its environment", () => {
        env.isPackaged = false;
        void runWaveSrv(() => {});
        env.isPackaged = true;
        void runWaveSrv(() => {});
        const [dev, packaged] = env.spawnedEnv;
        expect(dev.EXEC).toBe("/Applications/MoltenTerm.app/Contents/MacOS/MoltenTerm");
        expect(packaged.EXEC).toBe("");
    });
});
