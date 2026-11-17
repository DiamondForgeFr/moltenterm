// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The activity source over the stores it reads (FR-BOSS-009, AC85; FR-SHELL-122, #2233, #2294): it follows the agent
// states, the running work, the Integration panel's answers and its upcoming work (where the sub-agents are listed) for
// the workspace's projects, keeps the same summary while the same items run, holds the readings while a reader shows,
// and starts no timer of its own.

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
    tabs: null as PrimitiveAtom<Record<string, unknown>>,
    watching: 0,
    upcomingWatching: 0,
}));

vi.mock("@/app/store/wos", async () => {
    const jotai = await import("jotai");
    m.tabs = jotai.atom({}) as PrimitiveAtom<Record<string, unknown>>;
    return {
        makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
        getWaveObjectAtom: (oref: string) => jotai.atom((get) => get(m.tabs)[oref]),
    };
});
vi.mock("./activity-upcoming", () => ({
    watchActivityUpcoming: () => {
        m.upcomingWatching++;
        return () => {
            m.upcomingWatching--;
        };
    },
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
import { SharedReviewsAnswersAtom, SharedUpcomingAnswersAtom } from "../reviews/reviews-state-atoms";
import type { BranchAgent, UpcomingAnswer } from "../reviews/reviews-upcoming-model";
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

function subagent(parent: string, state: BranchAgent["state"], more: Partial<BranchAgent> = {}): BranchAgent {
    return {
        branch: "",
        worktree: "",
        kind: "subagent",
        parentblockid: parent,
        state,
        agentid: `${parent}-${state}-${more.description ?? ""}`,
        ...more,
    };
}

function setUpcoming(dir: string, ...agents: BranchAgent[]) {
    const answer: UpcomingAnswer = { dir, branches: [], agents, at: Date.now() };
    globalStore.set(SharedUpcomingAnswersAtom, { ...globalStore.get(SharedUpcomingAnswersAtom), [dir]: answer });
}

function summary() {
    return globalStore.get(ActivitySource.getInstance().summaryAtom);
}

beforeEach(() => {
    ActivitySource.resetInstance();
    m.watching = 0;
    m.upcomingWatching = 0;
    globalStore.set(m.workspace, workspace([Dir]));
    globalStore.set(m.tabs, {});
    globalStore.set(SharedUpcomingAnswersAtom, {});
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
});

describe("the sub-agents of the workspace's agents (#2294)", () => {
    it("runs while an idle lead's two background sub-agents work, and goes out when they stop", () => {
        setAgents(agent("lead", "idle", 10));
        expect(summary().count).toBe(0);
        setUpcoming(
            Dir,
            subagent("lead", "running", { description: "a" }),
            subagent("lead", "running", { description: "b" })
        );
        expect(summary().count).toBe(1);
        expect(summary().subagents).toBe(2);
        expect(summary().items[0].id).toBe("agent:lead");
        expect(globalStore.get(ActivitySource.getInstance().countAtom)).toBe(1);
        expect(globalStore.get(ActivitySource.getInstance().busyAtom)).toBe(true);
        setUpcoming(
            Dir,
            subagent("lead", "done", { description: "a" }),
            subagent("lead", "quiet", { description: "b" })
        );
        expect(summary().count).toBe(0);
        expect(globalStore.get(ActivitySource.getInstance().busyAtom)).toBe(false);
    });

    it("counts the sub-agents of the projects of the workspace only, and one that every project lists once", () => {
        setAgents(agent("lead", "idle", 10));
        globalStore.set(m.workspace, workspace([Dir, Other]));
        const shared = subagent("lead", "running", { agentid: "same", description: "reviewer" });
        setUpcoming(Dir, shared);
        setUpcoming(Other, shared);
        setUpcoming("/work/elsewhere", subagent("lead", "running", { agentid: "far" }));
        expect(summary().subagents).toBe(1);
    });

    it("leaves out the sub-agents of another workspace's lead, and of a lead the agent states do not hold", () => {
        setAgents({ ...agent("far", "idle", 10), workspaceid: "ws-b" });
        setUpcoming(Dir, subagent("far", "running"), subagent("gone", "running"));
        expect(summary().count).toBe(0);
        expect(summary().subagents).toBe(0);
    });

    it("counts a working lead once, with its sub-agents", () => {
        setAgents(agent("lead", "working", 10));
        setUpcoming(
            Dir,
            subagent("lead", "running", { description: "a" }),
            subagent("lead", "running", { description: "b" })
        );
        expect(summary().count).toBe(1);
        expect(summary().subagents).toBe(2);
    });
});

describe("what waits for the developer (#2294)", () => {
    it("holds the waiting agents of the workspace beside what runs, and counts none of them as running", () => {
        setAgents(
            { ...agent("ask", "waiting", 5), since: 100, firstname: "Flore", tabid: "t1" },
            { ...agent("far", "waiting", 5), workspaceid: "ws-b", tabid: "t2" }
        );
        globalStore.set(m.tabs, { "tab:t1": { name: "Cadrage" }, "tab:t2": { name: "Elsewhere" } });
        expect(summary().count).toBe(0);
        expect(summary().waiting.map((w) => [w.name, w.place])).toEqual([["Flore", "Cadrage"]]);
        expect(globalStore.get(ActivitySource.getInstance().countAtom)).toBe(0);
    });

    it("shows both at once: a build runs and an answer is awaited", () => {
        setAgents({ ...agent("ask", "waiting", 5), tabid: "t1" });
        setWork({ kind: "build" });
        expect(summary().count).toBe(1);
        expect(summary().waiting).toHaveLength(1);
    });

    it("follows the shown name of the tab when it changes", () => {
        setAgents({ ...agent("ask", "waiting", 5), tabid: "t1" });
        globalStore.set(m.tabs, { "tab:t1": { name: "Cadrage" } });
        expect(summary().waiting[0].place).toBe("Cadrage");
        globalStore.set(m.tabs, { "tab:t1": { name: "Review" } });
        expect(summary().waiting[0].place).toBe("Review");
    });
});

describe("the upcoming work's reading (#2294)", () => {
    it("is held once for all the readers, and let go with the last", () => {
        const source = ActivitySource.getInstance();
        const first = source.watch();
        const second = source.watch();
        expect(m.upcomingWatching).toBe(1);
        expect(m.watching).toBe(2);
        first();
        first();
        expect(m.upcomingWatching).toBe(1);
        second();
        expect(m.upcomingWatching).toBe(0);
        expect(m.watching).toBe(0);
    });

    it("depends on the workspace's projects and open agents, and is worth asking only with an agent open", () => {
        const source = ActivitySource.getInstance();
        const key = () => globalStore.get(source.upcomingKeyAtom);
        expect(globalStore.get(source.openAgentAtom)).toBe(false);
        const empty = key();
        setAgents(agent("lead", "idle", 10));
        expect(globalStore.get(source.openAgentAtom)).toBe(true);
        const withLead = key();
        expect(withLead).not.toBe(empty);
        setAgents({ ...agent("lead", "working", 10), version: 5, message: "reading" });
        expect(key()).toBe(withLead);
        globalStore.set(m.workspace, workspace([Dir, Other]));
        expect(key()).not.toBe(withLead);
        setAgents({ ...agent("lead", "idle", 10), own: true });
        expect(globalStore.get(source.openAgentAtom)).toBe(false);
    });
});

describe("the source's own calls", () => {
    it("asks for nothing: no timer, no interval, no call of its own", () => {
        for (const text of [src, modelSrc]) {
            expect(text).not.toMatch(/setInterval|setTimeout|\.every\(|wshRpcCall|TabActivity/);
        }
    });
});
