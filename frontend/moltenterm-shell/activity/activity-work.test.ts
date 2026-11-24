// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the popover says of each agent's sub-agents (#2502, FR-BOSS-009 AC85): each under its own agent, with its ticket,
// its age and the job it waits for in plain words and how long that job runs. Pure, so no window is needed.

import { describe, expect, it } from "vitest";
import type { AgentStateInfo, BackgroundJob, SubagentWork } from "../agent-state-model";
import {
    activityGroups,
    ActivityInputs,
    activityItems,
    activityKey,
    ActivityT,
    ActivityTCount,
    activityWaiting,
    ActivityWords,
    summarizeActivity,
} from "./activity-model";

const fakeT: ActivityT = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key);
const fakeTc: ActivityTCount = (key, count, vars) => `${key}:${count}${vars ? JSON.stringify(vars) : ""}`;

const Now = 10_000_000;
const words: ActivityWords = {
    t: fakeT,
    tc: fakeTc,
    now: Now,
    age: (startedat, now) => `${Math.round((now - startedat) / 60_000)}min`,
    server: (_text, english) => english,
};

let count = 0;

function lead(more: Partial<AgentStateInfo> = {}): AgentStateInfo {
    count++;
    return {
        blockid: `lead-${count}`,
        tabid: `tab-${count}`,
        workspaceid: "ws-1",
        agent: "claude",
        agentname: "Claude Code",
        firstname: `Lead${count}`,
        state: "idle",
        started: Now - 3_720_000,
        version: count,
        ...more,
    };
}

function work(id: string, more: Partial<SubagentWork> = {}): SubagentWork {
    return { id, description: `#${id.length}00 task of ${id}`, kind: "sf-build", started: Now - 600_000, ...more };
}

function job(kind: string, minutesAgo: number, arg?: string): BackgroundJob {
    return { kind, arg, since: Now - minutesAgo * 60_000 };
}

function summaryOf(list: AgentStateInfo[], more: Partial<ActivityInputs> = {}) {
    const inputs: ActivityInputs = {
        agents: Object.fromEntries(list.map((a) => [a.blockid, a])),
        work: [],
        answers: {},
        dirs: ["/work/p"],
        workspaceid: "ws-1",
        folders: ["/work/p"],
        ...more,
    };
    return summarizeActivity(activityItems(inputs), activityWaiting(inputs));
}

describe("the sub-agents listed under their agent", () => {
    it("has each lead list its own sub-agents only, never another agent's of the same folder", () => {
        const clara = lead({ state: "idle", subagents: 2, background: true, work: [work("aa"), work("bbb")] });
        const basile = lead({ state: "working", subagents: 1, work: [work("cccc")] });
        const quiet = lead({ state: "idle" });
        const groups = activityGroups(summaryOf([clara, basile, quiet]), words);
        expect(groups.map((g) => g.id)).toEqual(["agents"]);
        const rows = Object.fromEntries(groups[0].rows.map((r) => [r.what, r]));
        expect(rows[clara.firstname].subs.map((s) => s.id)).toEqual(["aa", "bbb"]);
        expect(rows[basile.firstname].subs.map((s) => s.id)).toEqual(["cccc"]);
        expect(rows[quiet.firstname]).toBeUndefined();
    });

    it("says 'N sub-agents at work' on the lead's row, with its age", () => {
        const clara = lead({ subagents: 3, background: true, work: [work("aa"), work("bbb"), work("cccc")] });
        const [row] = activityGroups(summaryOf([clara]), words)[0].rows;
        expect(row.what).toBe(clara.firstname);
        expect(row.detail).toBe("activity.row.subagents:3");
        expect(row.since).toBe("62min");
        expect(row.subs).toHaveLength(3);
        expect(row.whereKey).toBe("activity.open.agent");
    });

    it("words a sub-agent on two lines: its ticket and task with its age, then its job and since when", () => {
        const clara = lead({
            subagents: 1,
            background: true,
            work: [
                work("aa", {
                    description: "#2496 Tree scans that read every file",
                    started: Now - 62 * 60_000,
                    waiting: true,
                    jobs: [job("vitest", 7)],
                }),
            ],
        });
        const [sub] = activityGroups(summaryOf([clara]), words)[0].rows[0].subs;
        expect(sub).toMatchObject({
            id: "aa",
            ticket: "#2496",
            title: "Tree scans that read every file",
            age: "62min",
            job: "activity.job.vitest",
            waits: "activity.sub.waiting.tests",
            jobAge: 'activity.sub.since{"age":"7min"}',
            hasJob: true,
            whereKey: "activity.open.agent",
        });
        expect(sub.target).toMatchObject({ type: "agent", blockid: clara.blockid });
    });

    it("words the job by what it is: tests, a build, a script with its name, a command nobody knows", () => {
        const kinds: [BackgroundJob, string, string][] = [
            [job("gotest", 1), "activity.job.gotest", "activity.sub.waiting.tests"],
            [job("buildfrontend", 1), "activity.job.buildfrontend", "activity.sub.waiting.build"],
            [job("perf", 1), "activity.job.perf", "activity.sub.waiting.build"],
            [job("moltenci", 1), "activity.job.moltenci", "activity.sub.waiting.ci"],
            [job("npmrun", 1, "lint"), 'activity.job.npmrunArg{"script":"lint"}', "activity.sub.waiting.command"],
            [job("command", 1), "activity.job.command", "activity.sub.waiting.command"],
            [job("a-kind-of-a-newer-version", 1), "activity.job.command", "activity.sub.waiting.command"],
        ];
        for (const [one, job_, waits] of kinds) {
            const clara = lead({ subagents: 1, work: [work("aa", { waiting: true, jobs: [one] })] });
            const [sub] = activityGroups(summaryOf([clara]), words)[0].rows[0].subs;
            expect([one.kind, sub.job, sub.waits]).toEqual([one.kind, job_, waits]);
        }
    });

    it("names the oldest job and counts the others", () => {
        const clara = lead({
            subagents: 1,
            work: [work("aa", { waiting: true, jobs: [job("vitest", 9), job("buildbackend", 4), job("command", 1)] })],
        });
        const [sub] = activityGroups(summaryOf([clara]), words)[0].rows[0].subs;
        expect(sub.job).toBe('activity.sub.jobMore{"job":"activity.job.vitest","count":2}');
        expect(sub.jobAge).toBe('activity.sub.since{"age":"9min"}');
    });

    it("says a sub-agent in its turn is at work, and one waiting with no job known waits on its background work", () => {
        const clara = lead({
            subagents: 2,
            work: [work("aa"), work("bb", { waiting: true })],
        });
        const [working, waiting] = activityGroups(summaryOf([clara]), words)[0].rows[0].subs;
        expect(working).toMatchObject({ job: "activity.sub.working", waits: "", jobAge: "", hasJob: false });
        expect(waiting).toMatchObject({ job: "activity.sub.waitingWork", waits: "", jobAge: "", hasJob: false });
    });

    it("leaves out an age and a ticket it does not know, and titles a task with no words by its type", () => {
        const clara = lead({
            subagents: 1,
            work: [{ id: "aa", kind: "sf-fix", description: "#77" }],
        });
        const [sub] = activityGroups(summaryOf([clara]), words)[0].rows[0].subs;
        expect(sub).toMatchObject({ ticket: "#77", title: "sf-fix", age: "" });
        const bare = lead({ subagents: 1, work: [{ id: "bb" }] });
        expect(activityGroups(summaryOf([bare]), words)[0].rows[0].subs[0]).toMatchObject({
            ticket: "",
            title: "activity.sub.untitled",
        });
    });

    it("lists a lead with no file-read work by its count alone", () => {
        const flore = lead({ state: "working", subagents: 2 });
        const [row] = activityGroups(summaryOf([flore]), words)[0].rows;
        expect(row.detail).toBe("activity.row.subagents:2");
        expect(row.subs).toBeUndefined();
    });
});

describe("what is not tied to an agent", () => {
    it("holds the local CI, the builds and a pull request's checks in one group after the agents", () => {
        const clara = lead({ state: "working", started: Now - 1000 });
        const summary = summaryOf([clara], {
            work: [
                { id: "r1", kind: "ci", dir: "/work/p", title: "ci", startedat: Now - 240_000, progress: -1 },
                {
                    id: "r2",
                    kind: "build",
                    dir: "/work/p",
                    title: "Gold packaging",
                    startedat: Now - 60_000,
                    progress: -1,
                },
            ],
        });
        const groups = activityGroups(summary, words);
        expect(groups.map((g) => g.id)).toEqual(["agents", "standalone"]);
        expect(groups[1].title).toBe("activity.group.standalone");
        expect(groups[1].rows.map((r) => r.what)).toEqual(["Gold packaging", "activity.row.localCi"]);
        expect(groups[1].rows.every((r) => r.subs === undefined)).toBe(true);
    });
});

describe("what makes the popover draw again", () => {
    it("changes the key when a job ends, starts or changes, and not when only an age moves", () => {
        const before = lead({ subagents: 1, work: [work("aa", { waiting: true, jobs: [job("vitest", 7)] })] });
        const key = (a: AgentStateInfo) => activityKey(summaryOf([a]));
        const ended = { ...before, work: [work("aa")] };
        const another = { ...before, work: [work("aa", { waiting: true, jobs: [job("gotest", 7)] })] };
        const aSecondOne = { ...before, work: [...before.work, work("bb")], subagents: 2 };
        expect(key(ended)).not.toBe(key(before));
        expect(key(another)).not.toBe(key(before));
        expect(key(aSecondOne)).not.toBe(key(before));
        expect(key({ ...before, version: before.version + 5 })).toBe(key(before));
    });
});

describe("the count of a lead whose files and hooks differ", () => {
    it("takes the larger of what the agent state counts and what the upcoming work lists", () => {
        const clara = lead({ subagents: 3, background: true, work: [work("aa"), work("bbb")] });
        const [item] = activityItems({
            agents: { [clara.blockid]: clara },
            work: [],
            answers: {},
            dirs: ["/work/p"],
            workspaceid: "ws-1",
            folders: ["/work/p"],
        });
        expect(item.about.subagents).toBe(3);
        expect(item.about.work).toHaveLength(2);
    });
});
