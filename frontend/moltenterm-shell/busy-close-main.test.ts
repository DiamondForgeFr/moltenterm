// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { answerMainAsk, MainBusyAsk, MainBusyDeps, MainBusyReply } from "./busy-close-main";
import { busyCloseText, RunningItem, splitQuitRunning } from "./busy-close-model";

vi.mock("@/app/store/global", () => ({ getApi: () => null, atoms: {}, getSettingsKeyAtom: () => null }));
vi.mock("@/app/store/services", () => ({ ObjectService: {}, WorkspaceService: {}, BlockService: {} }));
vi.mock("@/app/store/wos", () => ({
    makeORef: (t: string, id: string) => `${t}:${id}`,
    loadAndPinWaveObject: vi.fn(),
}));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

function agent(blockId: string, state = "working", workspace = "API"): RunningItem {
    return { blockId, kind: "agent", label: "Claude Code", state: state as any, workspace };
}

function command(blockId: string, label = "/bin/sleep 86400", workspace = "API"): RunningItem {
    return { blockId, kind: "command", label, workspace };
}

function makeDeps(over: Partial<MainBusyDeps> = {}): MainBusyDeps & { replies: MainBusyReply[]; asked: any[] } {
    const replies: MainBusyReply[] = [];
    const asked: any[] = [];
    const deps = {
        replies,
        asked,
        reply: (r: MainBusyReply) => replies.push(r),
        enabled: () => true,
        dialogOpen: () => false,
        workspaceIds: async () => ["ws-a", "ws-b"],
        readWorkspace: async (): Promise<RunningItem[]> => [],
        durableOf: async () => new Set<string>(),
        ask: async (req: any) => {
            asked.push(req);
            return true;
        },
        ...over,
    };
    return deps;
}

const outcomeOf = (replies: MainBusyReply[]) => replies.find((r) => r.phase === "result")?.outcome;

function ask(kind: string, over: Partial<MainBusyAsk> = {}): MainBusyAsk {
    return { requestid: "r1", kind, stopworkspaceids: [], quit: false, ...over };
}

describe("answering Electron main", () => {
    it("acks first, then answers off when the setting is off (AC5)", async () => {
        const deps = makeDeps({ enabled: () => false });
        await answerMainAsk(ask("window", { stopworkspaceids: ["ws-a"] }), deps);
        expect(deps.replies[0]).toEqual({ requestid: "r1", phase: "ack" });
        expect(outcomeOf(deps.replies)).toBe("off");
        expect(deps.asked).toHaveLength(0);
    });

    it("answers none when nothing runs, so Electron's confirmation decides", async () => {
        const deps = makeDeps();
        await answerMainAsk(ask("delete", { stopworkspaceids: ["ws-a"] }), deps);
        expect(outcomeOf(deps.replies)).toBe("none");
        expect(deps.asked).toHaveLength(0);
    });

    it("asks for a delete with what runs in the workspace and the user's answer", async () => {
        const deps = makeDeps({
            readWorkspace: async (id) => (id === "ws-a" ? [command("b1")] : [agent("b9")]),
            ask: async (req) => {
                deps.asked.push(req);
                return false;
            },
        });
        await answerMainAsk(ask("delete", { stopworkspaceids: ["ws-a"], name: "API" }), deps);
        expect(deps.replies.map((r) => r.phase)).toEqual(["ack", "asking", "result"]);
        expect(outcomeOf(deps.replies)).toBe("cancel");
        expect(deps.asked[0]).toMatchObject({ action: "delete", name: "API", kept: [] });
        expect(deps.asked[0].running.map((r: RunningItem) => r.blockId)).toEqual(["b1"]);
    });

    it("a quit lists the non-durable terminals of every workspace and names durable sessions as kept (AC2)", async () => {
        const deps = makeDeps({
            readWorkspace: async (id) => (id === "ws-a" ? [command("plain")] : [agent("durable-agent"), command("b2")]),
            durableOf: async () => new Set(["durable-agent"]),
        });
        await answerMainAsk(ask("quit", { quit: true, name: "MoltenTerm" }), deps);
        expect(outcomeOf(deps.replies)).toBe("close");
        const req = deps.asked[0];
        expect(req.running.map((r: RunningItem) => r.blockId)).toEqual(["plain", "b2"]);
        expect(req.kept.map((r: RunningItem) => r.blockId)).toEqual(["durable-agent"]);
    });

    it("a quit whose only busy terminals are durable asks nothing", async () => {
        const deps = makeDeps({
            readWorkspace: async (id) => (id === "ws-b" ? [agent("d1")] : []),
            durableOf: async () => new Set(["d1"]),
        });
        await answerMainAsk(ask("quit", { quit: true }), deps);
        expect(outcomeOf(deps.replies)).toBe("none");
    });

    it("a last-window close that quits lists the deleted workspace's durable terminals as stopping", async () => {
        const deps = makeDeps({
            readWorkspace: async (id) => (id === "ws-a" ? [agent("d-own")] : [command("other")]),
            durableOf: async () => new Set(["d-own", "other"]),
        });
        await answerMainAsk(ask("window", { quit: true, stopworkspaceids: ["ws-a"] }), deps);
        const req = deps.asked[0];
        expect(req.quits).toBe(true);
        expect(req.running.map((r: RunningItem) => r.blockId)).toEqual(["d-own"]);
        expect(req.kept.map((r: RunningItem) => r.blockId)).toEqual(["other"]);
    });

    it("answers cancel when another close dialog of the window is open", async () => {
        const deps = makeDeps({ dialogOpen: () => true, readWorkspace: async () => [command("b1")] });
        await answerMainAsk(ask("switch", { stopworkspaceids: ["ws-a"] }), deps);
        expect(outcomeOf(deps.replies)).toBe("cancel");
        expect(deps.asked).toHaveLength(0);
    });

    it("answers error when the read throws, so main falls back", async () => {
        const deps = makeDeps({
            readWorkspace: async () => [command("b1")],
            ask: async () => {
                throw new Error("boom");
            },
        });
        await answerMainAsk(ask("window", { stopworkspaceids: ["ws-a"] }), deps);
        expect(outcomeOf(deps.replies)).toBe("error");
    });

    it("answers off for an action it does not know", async () => {
        const deps = makeDeps();
        await answerMainAsk(ask("pane"), deps);
        expect(outcomeOf(deps.replies)).toBe("off");
    });
});

describe("the texts of main's dialogs", () => {
    it("names each action", () => {
        expect(busyCloseText("window").title).toBe("Close this window?");
        expect(busyCloseText("window", undefined, true).subtitle).toMatch(/last window quits/);
        expect(busyCloseText("quit", "MoltenTerm Gold")).toMatchObject({
            title: "Quit MoltenTerm Gold?",
            confirm: "Quit anyway",
        });
        expect(busyCloseText("delete", "API")).toMatchObject({
            title: "Delete the workspace “API”?",
            confirm: "Delete anyway",
        });
        expect(busyCloseText("delete").title).toBe("Delete the workspace “Unsaved workspace”?");
        expect(busyCloseText("switch").confirm).toBe("Switch anyway");
        expect(busyCloseText("tab", "build").title).toBe("Close the view “build”?");
    });

    it("keeps agents first across the stopping and the quit lists", () => {
        const { running, kept } = splitQuitRunning([command("own")], [agent("a1", "idle"), agent("a2")], new Set());
        expect(running.map((r) => r.blockId)).toEqual(["a2", "a1", "own"]);
        expect(kept).toEqual([]);
    });
});
