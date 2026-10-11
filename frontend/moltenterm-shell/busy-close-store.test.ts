// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
    settings: {} as Record<string, unknown>,
    status: {} as Record<string, Promise<any>>,
    rtinfo: {} as Record<string, Promise<any>>,
    objects: {} as Record<string, any>,
    agents: {} as Record<string, any>,
    blocksList: [] as any[],
    statusCalls: [] as string[],
}));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { workspace: atom({ oid: "ws", name: "Work" }) },
        getApi: () => ({ getHomeDir: () => "/Users/me" }),
        getSettingsKeyAtom: (key: string) => atom(app.settings[key]),
    };
});
vi.mock("@/app/store/services", () => ({
    BlockService: {
        GetControllerStatus: (blockId: string) => {
            app.statusCalls.push(blockId);
            return app.status[blockId] ?? Promise.resolve({ shellprocstatus: "running" });
        },
    },
}));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetRTInfoCommand: (_client: any, data: { oref: string }) =>
            app.rtinfo[data.oref.replace("block:", "")] ?? Promise.resolve({}),
        BlocksListCommand: () => Promise.resolve(app.blocksList),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    loadAndPinWaveObject: (oref: string) => Promise.resolve(app.objects[oref] ?? null),
}));
vi.mock("./agent-state-store", async () => {
    const { atom } = await import("jotai");
    // A fresh atom per read: each test sets its own agent states.
    return { AgentStates: { getInstance: () => ({ dataAtom: atom(() => ({ states: app.agents, versions: {} })) }) } };
});

import {
    busyCloseEnabled,
    ConfirmBusyCloseKey,
    readRunning,
    ReadTimeoutMs,
    readWorkspaceRunning,
} from "./busy-close-store";

const busyShell = (cmd: string) =>
    Promise.resolve({ "shell:integration": true, "shell:state": "running-command", "shell:lastcmd": cmd });
const idleShell = () => Promise.resolve({ "shell:integration": true, "shell:state": "ready" });

beforeEach(() => {
    app.settings = {};
    app.status = {};
    app.rtinfo = {};
    app.agents = {};
    app.blocksList = [];
    app.statusCalls = [];
    app.objects = {
        "tab:t1": { oid: "t1", name: "T1", blockids: ["b1", "b2"] },
        "block:b1": { oid: "b1", meta: { view: "term", "cmd:cwd": "/Users/me/api" } },
    };
});

afterEach(() => {
    vi.useRealTimers();
});

describe("reading what a close stops (FR-SHELL-061)", () => {
    it("asks unless the setting is off", () => {
        expect(busyCloseEnabled()).toBe(true);
        app.settings[ConfirmBusyCloseKey] = false;
        expect(busyCloseEnabled()).toBe(false);
    });

    it("reads every terminal, names its tab as the tab shows it, and skips other views", async () => {
        app.rtinfo.b1 = busyShell("npm run dev");
        app.rtinfo.b2 = idleShell();
        app.agents.b3 = { blockid: "b3", agent: "codex", agentname: "Codex", state: "working", version: 2 };
        const running = await readRunning([
            { blockId: "b1", meta: { view: "term" }, tabId: "t1" },
            { blockId: "b2", meta: { view: "term" }, tabId: "t1" },
            { blockId: "b3", meta: { view: "term" }, tabId: "t1" },
            { blockId: "p1", meta: { view: "preview" }, tabId: "t1" },
        ]);
        expect(running).toEqual([
            { blockId: "b3", kind: "agent", label: "Codex", state: "working", workspace: "Work", tab: "api" },
            { blockId: "b1", kind: "command", label: "npm run dev", workspace: "Work", tab: "api" },
        ]);
        expect(app.statusCalls).toEqual(["b1", "b2", "b3"]);
    });

    it("does not ask for a terminal whose shell has exited", async () => {
        app.rtinfo.b1 = busyShell("exit");
        app.status.b1 = Promise.resolve({ shellprocstatus: "done" });
        expect(await readRunning([{ blockId: "b1", meta: { view: "term" }, tabId: "t1" }])).toEqual([]);
    });

    it("never holds a close on a slow backend: past the timeout the agent states decide alone", async () => {
        vi.useFakeTimers();
        const never = new Promise<any>(() => {});
        app.rtinfo.b1 = never;
        app.rtinfo.b2 = never;
        app.agents.b2 = { blockid: "b2", agent: "claude", agentname: "Claude Code", state: "idle", version: 1 };
        const pending = readRunning([
            { blockId: "b1", meta: { view: "term" } },
            { blockId: "b2", meta: { view: "term" } },
        ]);
        await vi.advanceTimersByTimeAsync(ReadTimeoutMs + 10);
        const running = await pending;
        expect(running.map((r) => r.blockId)).toEqual(["b2"]);
    });

    it("reads the whole workspace for a reset", async () => {
        app.blocksList = [
            { blockid: "b1", tabid: "t1", meta: { view: "term" } },
            { blockid: "w1", tabid: "t1", meta: { view: "web" } },
        ];
        app.rtinfo.b1 = busyShell("cat");
        const running = await readWorkspaceRunning("ws", "Notes");
        expect(running).toEqual([{ blockId: "b1", kind: "command", label: "cat", workspace: "Notes", tab: "api" }]);
    });
});
