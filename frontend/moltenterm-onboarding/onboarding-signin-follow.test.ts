// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The end of the sign-in terminal (FR-ONB-007 AC-5b, #1733): a confirmed sign-in closes it and updates the card, an
// error leaves it open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
    procStatus: "running" as string,
    done: null as any,
    deleted: [] as string[],
    doneAsked: [] as string[],
    lists: 0,
}));

vi.mock("@/app/store/global", () => ({ createBlock: vi.fn(), createBlockSplitHorizontally: vi.fn() }));
vi.mock("@/app/store/wos", () => ({ makeORef: (otype: string, oid: string) => `${otype}:${oid}` }));
vi.mock("@/app/store/services", () => ({
    BlockService: { GetControllerStatus: async () => ({ shellprocstatus: calls.procStatus }) },
    ObjectService: {
        GetObject: async () => ({ oid: "b1" }),
        DeleteBlock: async (blockId: string) => {
            calls.deleted.push(blockId);
        },
    },
}));
vi.mock("./onboarding-client", () => ({
    agentSignInMeta: vi.fn(),
    agentSignInDone: async (id: string, blockId: string) => {
        calls.doneAsked.push(`${id}/${blockId}`);
        return calls.done;
    },
    listOnboardingAgents: async () => {
        calls.lists++;
        return { version: "1", agents: [{ id: "cursor", signedin: calls.done?.signedin ?? false }] };
    },
}));

import { globalStore } from "@/app/store/jotaiStore";
import { AgentSignInModel } from "./onboarding-signin";

beforeEach(() => {
    vi.useFakeTimers();
    AgentSignInModel.resetInstance();
    calls.procStatus = "running";
    calls.done = null;
    calls.deleted = [];
    calls.doneAsked = [];
    calls.lists = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

async function followUntilDone(model: AgentSignInModel, onList: (list: any) => void): Promise<void> {
    const run = model.follow("cursor", "b1", onList);
    await vi.advanceTimersByTimeAsync(2000);
    calls.procStatus = "done";
    await vi.advanceTimersByTimeAsync(2000);
    await run;
}

describe("the end of the sign-in terminal", () => {
    it("closes it and updates the card when wavesrv confirms the sign-in", async () => {
        calls.done = { ended: true, exitcode: 0, signedin: true, checkedby: "status" };
        const model = AgentSignInModel.getInstance();
        const lists: any[] = [];
        await followUntilDone(model, (l) => lists.push(l));
        expect(calls.doneAsked).toEqual(["cursor/b1"]);
        expect(calls.deleted).toEqual(["b1"]);
        expect(globalStore.get(model.runsAtom).cursor.state).toBe("signedin");
        expect(lists.at(-1).agents[0].signedin).toBe(true);
    });

    it("keeps it open on an error code", async () => {
        calls.done = { ended: true, exitcode: 1, signedin: false };
        const model = AgentSignInModel.getInstance();
        await followUntilDone(model, () => {});
        expect(calls.deleted).toEqual([]);
        expect(globalStore.get(model.runsAtom).cursor).toEqual({ state: "notfinished", blockId: "b1", exitCode: 1 });
    });

    it("sees a command already done at the first look", async () => {
        calls.procStatus = "done";
        calls.done = { ended: true, exitcode: 0, signedin: true, checkedby: "exit" };
        const model = AgentSignInModel.getInstance();
        const run = model.follow("cursor", "b1", () => {});
        await vi.advanceTimersByTimeAsync(2000);
        await run;
        expect(calls.deleted).toEqual(["b1"]);
    });
});
