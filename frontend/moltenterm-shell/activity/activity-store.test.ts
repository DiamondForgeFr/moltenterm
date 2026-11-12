// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The activity source over the stores it reads (FR-BOSS-009, AC85; FR-SHELL-122, #2233): it follows the agent states,
// the running work and the Integration panel's answers for the workspace's projects, keeps the same summary while the
// same items run, holds the work reading while a reader shows, and starts no timer of its own.

import { readFileSync } from "fs";
import type { PrimitiveAtom } from "jotai";
import { fileURLToPath } from "url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import type { WorkItem } from "../running-work";

const m = vi.hoisted(() => ({
    workspace: null as PrimitiveAtom<unknown>,
    agents: null as PrimitiveAtom<unknown>,
    work: null as PrimitiveAtom<unknown>,
    watching: 0,
}));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const jotai = await import("jotai");
    m.workspace = jotai.atom(null) as PrimitiveAtom<unknown>;
    return { atoms: { workspace: m.workspace } };
});
vi.mock("../agent-state-store", async () => {
    const jotai = await import("jotai");
    m.agents = jotai.atom({ states: {}, versions: {} }) as PrimitiveAtom<unknown>;
    return { AgentStates: { getInstance: () => ({ dataAtom: m.agents }) } };
});
vi.mock("../running-work", async () => {
    const jotai = await import("jotai");
    m.work = jotai.atom([]) as PrimitiveAtom<unknown>;
    return {
        RunningWork: {
            getInstance: () => ({
                itemsAtom: m.work,
                watch: () => {
                    m.watching++;
                    return () => {
                        m.watching--;
                    };
                },
            }),
        },
    };
});

import { globalStore } from "@/app/store/jotaiStore";
import { SharedReviewsAnswersAtom } from "../reviews/reviews-state-atoms";
import { ActivitySource, activityDirs, activityFolders } from "./activity-store";

const src = readFileSync(fileURLToPath(new URL("./activity-store.ts", import.meta.url)), "utf8");
const modelSrc = readFileSync(fileURLToPath(new URL("./activity-model.ts", import.meta.url)), "utf8");

const Dir = "/work/product";
const Other = "/work/product/mobile";

function workspace(dirs: string[], oid = "ws-1") {
    return {
        oid,
        name: "Product",
        meta: {
            "molten:project": dirs[0],
            "molten:projects": dirs.map((dir, i) => ({ id: `p${i + 1}`, type: "app", dir, branch: "" })),
            "molten:currentproject": "p1",
        },
    };
}

function agent(blockid: string, state: AgentStateInfo["state"], started = 0): AgentStateInfo {
    return { blockid, state, agent: "claude", agentname: "Claude Code", version: 1, started, workspaceid: "ws-1" };
}

function setAgents(...list: AgentStateInfo[]) {
    const data: AgentStatesData = { states: Object.fromEntries(list.map((a) => [a.blockid, a])), versions: {} };
    globalStore.set(m.agents, data);
}

function setWork(...items: Partial<WorkItem>[]) {
    globalStore.set(
        m.work,
        items.map((i, n) => ({ id: `w${n}`, kind: "build", dir: Dir, title: "t", startedat: 1, progress: -1, ...i }))
    );
}

function pr(number: number, state: string): ReviewPr {
    return {
        number,
        title: "t",
        url: "u",
        branch: "b",
        base: "develop",
        createdat: "",
        updatedat: "2026-11-11T09:00:00Z",
        merge: "clean",
        ci: { state: "pending", success: 0, failure: 0, pending: 1, checks: [{ name: "build", state: state as any }] },
        report: { state: "unknown" },
        unpublished: 0,
    };
}

function setAnswers(answers: Record<string, ReviewsAnswer>) {
    globalStore.set(SharedReviewsAnswersAtom, answers);
}

function summary() {
    return globalStore.get(ActivitySource.getInstance().summaryAtom);
}

beforeEach(() => {
    ActivitySource.resetInstance();
    m.watching = 0;
    globalStore.set(m.workspace, workspace([Dir]));
    setAgents();
    setWork();
    setAnswers({});
});

describe("the activity source", () => {
    it("holds nothing when nothing runs", () => {
        expect(summary().count).toBe(0);
        expect(globalStore.get(ActivitySource.getInstance().countAtom)).toBe(0);
    });

    it("follows an agent that works, a build, a local CI run and the checks of a pull request", () => {
        setAgents(agent("b1", "working", 10), agent("b2", "waiting"));
        expect(summary().kinds).toEqual({ agent: 1, build: 0, ci: 0 });
        setWork({ kind: "build" }, { kind: "ci" });
        expect(summary().kinds).toEqual({ agent: 1, build: 1, ci: 1 });
        setAnswers({ [Dir]: { dir: Dir, state: "ok", ready: [pr(3, "pending")], drafts: [] } });
        expect(summary().kinds).toEqual({ agent: 1, build: 1, ci: 2 });
        expect(globalStore.get(ActivitySource.getInstance().countAtom)).toBe(4);
        setAgents();
        setWork();
        setAnswers({ [Dir]: { dir: Dir, state: "ok", ready: [pr(3, "success")], drafts: [] } });
        expect(summary().count).toBe(0);
    });

    it("follows the pull requests of every project of the workspace, and only those", () => {
        const answers = {
            [Dir]: { dir: Dir, state: "ok" as const, ready: [pr(1, "pending")], drafts: [] },
            [Other]: { dir: Other, state: "ok" as const, ready: [pr(2, "pending")], drafts: [] },
            "/work/elsewhere": { dir: "/work/elsewhere", state: "ok" as const, ready: [pr(3, "pending")], drafts: [] },
        };
        setAnswers(answers);
        expect(summary().count).toBe(1);
        globalStore.set(m.workspace, workspace([Dir, Other]));
        expect(
            summary()
                .items.map((i) => (i.target.type === "pr-ci" ? i.target.number : 0))
                .sort()
        ).toEqual([1, 2]);
        expect(activityDirs(workspace([Dir, Other]) as any)).toEqual([Dir, Other]);
    });

    it("shows the window's workspace its own agents and runs, and follows a workspace switch at once (#2261)", () => {
        const ofA = { ...agent("a1", "working", 10), workspaceid: "ws-a" };
        const ofB = { ...agent("b1", "working", 20), workspaceid: "ws-b" };
        setAgents(ofA, ofB);
        setWork({ kind: "build", dir: "/work/b", workspaceid: "ws-b" }, { kind: "ci", dir: "/work/b" });
        globalStore.set(m.workspace, workspace(["/work/a"], "ws-a"));
        expect(summary().items.map((i) => i.id)).toEqual(["agent:a1"]);
        globalStore.set(m.workspace, workspace(["/work/b"], "ws-b"));
        expect(summary().items.map((i) => i.id)).toEqual(["agent:b1", "work:w0", "work:w1"]);
        globalStore.set(m.workspace, null);
        expect(summary().count).toBe(0);
    });

    it("takes a run that names no workspace when it runs in a project folder of the workspace", () => {
        setWork({ kind: "build", dir: Dir }, { kind: "build", dir: "/work/elsewhere" });
        expect(summary().count).toBe(1);
        expect(activityFolders(workspace([Dir, Other]) as any)).toEqual([Dir, Other]);
    });

    it("leaves out a pull request MoltenTerm merged, as the Integration list does", async () => {
        const { ReviewsMerges } = await import("../reviews/reviews-merges");
        setAnswers({ [Dir]: { dir: Dir, state: "ok", ready: [pr(8, "pending")], drafts: [] } });
        expect(summary().count).toBe(1);
        globalStore.set(ReviewsMerges.getInstance().mergesAtom, { [`${Dir}#8`]: { number: 8, at: Date.now() } });
        expect(summary().count).toBe(0);
        globalStore.set(ReviewsMerges.getInstance().mergesAtom, {});
    });

    it("gives the same summary while the same items say the same, so a version or a title moving draws nothing", () => {
        setAgents(agent("b1", "working", 10));
        const first = summary();
        setAgents({ ...agent("b1", "working", 10), version: 7, hooked: true });
        expect(summary()).toBe(first);
        setAgents({ ...agent("b1", "working", 10), message: "reading files" });
        expect(summary()).not.toBe(first);
        setAgents(agent("b1", "working", 10));
        const again = summary();
        setWork({});
        expect(summary()).not.toBe(again);
    });

    it("holds the work reading while a reader shows", () => {
        const source = ActivitySource.getInstance();
        const stop = source.watch();
        expect(m.watching).toBe(1);
        stop();
        expect(m.watching).toBe(0);
    });

    it("asks for nothing: no timer, no interval, no call of its own", () => {
        for (const text of [src, modelSrc]) {
            expect(text).not.toMatch(/setInterval|setTimeout|\.every\(|wshRpcCall|TabActivity/);
        }
    });
});
