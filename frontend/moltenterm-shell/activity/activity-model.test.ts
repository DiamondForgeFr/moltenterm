// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The activity source's rules (FR-BOSS-009, AC85; FR-SHELL-122, #2233, #2294): what counts as running, per kind, which
// item leads, the sub-agents that count through their lead, what waits for the developer, and the words that list it.
// Pure, so no window is needed.

import { describe, expect, it } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import enLocale from "../i18n/locales/en.json";
import frLocale from "../i18n/locales/fr.json";
import type { ReviewCheck, ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import type { BranchAgent, UpcomingAnswer } from "../reviews/reviews-upcoming-model";
import type { WorkItem } from "../running-work";
import {
    activityGlyph,
    ActivityGlyphIcons,
    activityGroups,
    ActivityInputs,
    activityItems,
    activityKey,
    activityLines,
    activityPopoverTitle,
    ActivityT,
    ActivityTCount,
    activityTexts,
    activityWaiting,
    activityWhereKey,
    ActivityWords,
    EmptyActivity,
    NamedPrs,
    openAgentsKey,
    subagentIsRunning,
    summarizeActivity,
} from "./activity-model";

const Dir = "/work/product";

// A translation that shows the key, the count and the variables it was given.
const fakeT: ActivityT = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key);
const fakeTc: ActivityTCount = (key, count, vars) => `${key}:${count}${vars ? JSON.stringify(vars) : ""}`;

let blockCount = 0;

function agent(state: AgentStateInfo["state"], more: Partial<AgentStateInfo> = {}): AgentStateInfo {
    blockCount++;
    return {
        blockid: `block-${blockCount}`,
        tabid: `tab-${blockCount}`,
        workspaceid: "ws-1",
        agent: "claude",
        agentname: "Claude Code",
        state,
        version: blockCount,
        ...more,
    };
}

function agents(...list: AgentStateInfo[]): Record<string, AgentStateInfo> {
    return Object.fromEntries(list.map((a) => [a.blockid, a]));
}

function work(kind: string, startedat: number, more: Partial<WorkItem> = {}): WorkItem {
    blockCount++;
    return { id: `run-${blockCount}`, kind, dir: Dir, title: kind, startedat, progress: -1, ...more };
}

function check(state: ReviewCheck["state"], more: Partial<ReviewCheck> = {}): ReviewCheck {
    return { name: `check-${state}`, state, ...more };
}

function pr(number: number, checks: ReviewCheck[], more: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://example.test/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        createdat: "2026-11-01T10:00:00Z",
        updatedat: "2026-11-01T10:00:00Z",
        merge: "clean",
        ci: {
            state: "pending",
            success: 0,
            failure: 0,
            pending: checks.filter((c) => c.state === "pending").length,
            checks,
        },
        report: { state: "unknown" },
        unpublished: 0,
        ...more,
    };
}

function answer(ready: ReviewPr[], drafts: ReviewPr[] = [], more: Partial<ReviewsAnswer> = {}): ReviewsAnswer {
    return { dir: Dir, state: "ok", ready, drafts, ...more };
}

function inputs(more: Partial<ActivityInputs> = {}): ActivityInputs {
    return { agents: {}, work: [], answers: {}, dirs: [Dir], workspaceid: "ws-1", folders: [Dir], ...more };
}

describe("what runs: the window's workspace only (#2261)", () => {
    const a = () => agent("working", { workspaceid: "ws-a" });
    const b = () => agent("working", { workspaceid: "ws-b" });

    it("shows each workspace its own agent, and none of the other's", () => {
        const list = agents(a(), b());
        const inA = activityItems(inputs({ agents: list, workspaceid: "ws-a" }));
        const inB = activityItems(inputs({ agents: list, workspaceid: "ws-b" }));
        expect(inA.map((i) => i.target.type === "agent" && i.target.workspaceid)).toEqual(["ws-a"]);
        expect(inB.map((i) => i.target.type === "agent" && i.target.workspaceid)).toEqual(["ws-b"]);
    });

    it("leaves out an agent whose workspace is not known, and every agent when the window's is not", () => {
        const list = agents(agent("working", { workspaceid: undefined }), a());
        expect(activityItems(inputs({ agents: list, workspaceid: "ws-a" }))).toHaveLength(1);
        expect(activityItems(inputs({ agents: list, workspaceid: "" }))).toEqual([]);
    });

    it("leaves a build started in another workspace out", () => {
        const list = [
            work("build", 1, { workspaceid: "ws-b", dir: "/work/b" }),
            work("ci", 2, { workspaceid: "ws-b" }),
        ];
        expect(activityItems(inputs({ work: list, workspaceid: "ws-a" }))).toEqual([]);
        expect(activityItems(inputs({ work: list, workspaceid: "ws-b" }))).toHaveLength(2);
    });

    it("takes a run that names no workspace by its folder, and leaves one with no folder of the workspace out", () => {
        const list = [
            work("build", 1, { dir: Dir }),
            work("ci", 2, { dir: "/work/elsewhere" }),
            work("update", 3, { dir: "" }),
        ];
        const items = activityItems(inputs({ work: list, workspaceid: "ws-a", folders: [Dir] }));
        expect(items.map((i) => i.kind)).toEqual(["build"]);
        expect(activityItems(inputs({ work: list, workspaceid: "ws-a", folders: [] }))).toEqual([]);
    });
});

describe("what runs: agents", () => {
    it("counts the agents that work in the workspace, and no other state", () => {
        const items = activityItems(
            inputs({
                agents: agents(
                    agent("working"),
                    agent("working", { workspaceid: "ws-other" }),
                    agent("waiting"),
                    agent("idle"),
                    agent("done"),
                    agent("error")
                ),
            })
        );
        expect(items).toHaveLength(1);
        expect(items.every((i) => i.kind === "agent" && i.target.type === "agent")).toBe(true);
    });

    it("leaves out Brokk's own session and a terminal where no agent was detected", () => {
        const items = activityItems(
            inputs({
                agents: agents(
                    agent("working", { own: true }),
                    agent("working", { agent: undefined, agentname: undefined })
                ),
            })
        );
        expect(items).toEqual([]);
    });

    it("keeps where the agent is, for the click, and when its run started", () => {
        const a = agent("working", { started: 5000, since: 9000 });
        const [item] = activityItems(inputs({ agents: agents(a) }));
        expect(item.startedat).toBe(5000);
        expect(item.target).toEqual({
            type: "agent",
            blockid: a.blockid,
            tabid: a.tabid,
            workspaceid: "ws-1",
        });
        const [later] = activityItems(inputs({ agents: agents(agent("working", { since: 9000 })) }));
        expect(later.startedat).toBe(9000);
        const [unknown] = activityItems(inputs({ agents: agents(agent("working")) }));
        expect(unknown.startedat).toBe(0);
    });
});

describe("what runs: builds and local CI", () => {
    it("takes every run MoltenTerm started as a build, whatever its sort", () => {
        const items = activityItems(
            inputs({
                work: [
                    work("build", 10, { workspaceid: "ws-1" }),
                    work("release", 20),
                    work("step", 30),
                    work("sync", 40),
                ],
            })
        );
        expect(items.map((i) => i.kind)).toEqual(["build", "build", "build", "build"]);
        expect(items[0].target).toEqual({ type: "build", dir: Dir, workspaceid: "ws-1" });
    });

    it("takes a local CI run as CI, which lives in the CI panel's local tab", () => {
        const [item] = activityItems(inputs({ work: [work("ci", 77)] }));
        expect(item.kind).toBe("ci");
        expect(item.startedat).toBe(77);
        expect(item.target).toEqual({ type: "local-ci", dir: Dir });
    });
});

describe("what runs: the GitHub checks of the pull requests followed", () => {
    it("counts an open pull request, draft or not, with a check of GitHub running", () => {
        const items = activityItems(
            inputs({
                answers: {
                    [Dir]: answer(
                        [pr(12, [check("pending"), check("success")]), pr(13, [check("success")])],
                        [pr(14, [check("pending")])]
                    ),
                },
            })
        );
        expect(items.map((i) => i.target)).toEqual([
            { type: "pr-ci", dir: Dir, number: 12, url: "https://example.test/pull/12" },
            { type: "pr-ci", dir: Dir, number: 14, url: "https://example.test/pull/14" },
        ]);
        expect(items.every((i) => i.kind === "ci")).toBe(true);
    });

    it("does not count a check that finished, failed, or ran on this computer (the work list says it once)", () => {
        const items = activityItems(
            inputs({
                answers: {
                    [Dir]: answer([
                        pr(1, [check("failure"), check("success"), check("neutral")]),
                        pr(2, [check("pending", { local: true })]),
                        pr(3, [check("interrupted"), check("untrusted"), check("notlocal")]),
                        pr(4, []),
                    ]),
                },
            })
        );
        expect(items).toEqual([]);
    });

    it("reads only the projects of the workspace, and only an answer that holds pull requests", () => {
        const running = [pr(5, [check("pending")])];
        const items = activityItems(
            inputs({
                dirs: [Dir, "/work/other-ok", "/work/other-bad"],
                answers: {
                    [Dir]: answer(running),
                    "/work/other-ok": answer(running, [], { dir: "/work/other-ok" }),
                    "/work/other-bad": answer(running, [], { dir: "/work/other-bad", state: "loggedout" }),
                    "/work/not-followed": answer(running, [], { dir: "/work/not-followed" }),
                },
            })
        );
        expect(items.map((i) => (i.target.type === "pr-ci" ? i.target.dir : ""))).toEqual([Dir, "/work/other-ok"]);
        expect(activityItems(inputs({ answers: {} }))).toEqual([]);
        expect(activityItems(inputs({ answers: { [Dir]: null } }))).toEqual([]);
    });

    it("counts a pull request once, and dates it by its earliest running check", () => {
        const both = pr(
            9,
            [
                check("pending", { startedat: "2026-11-11T10:05:00Z" }),
                check("pending", { startedat: "2026-11-11T10:01:00Z" }),
            ],
            { updatedat: "2026-11-11T09:00:00Z" }
        );
        const items = activityItems(inputs({ answers: { [Dir]: answer([both], [both]) } }));
        expect(items).toHaveLength(1);
        expect(items[0].startedat).toBe(Date.parse("2026-11-11T10:01:00Z"));
        const undated = pr(10, [check("pending")], { updatedat: "2026-11-11T09:00:00Z" });
        const [fallback] = activityItems(inputs({ answers: { [Dir]: answer([undated]) } }));
        expect(fallback.startedat).toBe(Date.parse("2026-11-11T09:00:00Z"));
        const unknown = pr(11, [check("pending")], { updatedat: "" });
        const [none] = activityItems(inputs({ answers: { [Dir]: answer([unknown]) } }));
        expect(none.startedat).toBe(0);
    });
});

describe("the summary", () => {
    it("says nothing runs with an empty list", () => {
        expect(summarizeActivity([])).toBe(EmptyActivity);
        expect(summarizeActivity(null)).toBe(EmptyActivity);
        expect(EmptyActivity.count).toBe(0);
        expect(EmptyActivity.lead).toBeNull();
    });

    it("counts per kind and leads with the item started most recently", () => {
        const summary = summarizeActivity(
            activityItems(
                inputs({
                    agents: agents(agent("working", { started: 100 }), agent("working", { started: 300 })),
                    work: [work("build", 200), work("ci", 400)],
                    answers: { [Dir]: answer([pr(7, [check("pending", { startedat: "1970-01-01T00:00:00.250Z" })])]) },
                })
            )
        );
        expect(summary.count).toBe(5);
        expect(summary.kinds).toEqual({ agent: 2, build: 1, ci: 2 });
        expect(summary.items.map((i) => i.startedat)).toEqual([400, 300, 250, 200, 100]);
        expect(summary.lead.kind).toBe("ci");
        expect(summary.lead.target.type).toBe("local-ci");
    });

    it("settles a tie by kind (agent, build, CI), then by id, and never leads with an item of unknown start", () => {
        const tie = summarizeActivity(
            activityItems(
                inputs({ agents: agents(agent("working", { started: 50 })), work: [work("ci", 50), work("build", 50)] })
            )
        );
        expect(tie.items.map((i) => i.kind)).toEqual(["agent", "build", "ci"]);
        const unknown = summarizeActivity(
            activityItems(inputs({ agents: agents(agent("working")), work: [work("build", 10)] }))
        );
        expect(unknown.lead.kind).toBe("build");
    });

    it("has one item for one running thing and none for a run that ended", () => {
        const ended = inputs({ work: [] });
        expect(summarizeActivity(activityItems(ended)).count).toBe(0);
        const one = summarizeActivity(activityItems(inputs({ work: [work("build", 1)] })));
        expect(one.count).toBe(1);
        expect(one.kinds).toEqual({ agent: 0, build: 1, ci: 0 });
    });

    it("keeps the same key while the same items say the same, whatever else about their source moved", () => {
        const a = agent("working", { started: 10, message: "reading files" });
        const first = summarizeActivity(activityItems(inputs({ agents: agents(a) })));
        const again = summarizeActivity(
            activityItems(inputs({ agents: agents({ ...a, version: 99, hooked: true, model: "other" }) }))
        );
        expect(activityKey(again)).toBe(activityKey(first));
        const other = summarizeActivity(activityItems(inputs({ agents: agents(a, agent("working")) })));
        expect(activityKey(other)).not.toBe(activityKey(first));
    });

    it("changes the key when a row would say something else: the agent's line, a CI run's job, a PR's checks", () => {
        const a = agent("working", { started: 10, message: "reading files" });
        const key = (list: ActivityInputs) => activityKey(summarizeActivity(activityItems(list)));
        expect(key(inputs({ agents: agents({ ...a, message: "running the tests" }) }))).not.toBe(
            key(inputs({ agents: agents(a) }))
        );
        expect(key(inputs({ work: [work("ci", 5, { id: "r", detail: "lint" })] }))).not.toBe(
            key(inputs({ work: [work("ci", 5, { id: "r", detail: "tests" })] }))
        );
        const checks = (done: number) => pr(3, [...Array(done).fill(check("success")), check("pending")]);
        expect(key(inputs({ answers: { [Dir]: answer([checks(2)]) } }))).not.toBe(
            key(inputs({ answers: { [Dir]: answer([checks(3)]) } }))
        );
    });
});

describe("the indicator's picture", () => {
    const glyphOf = (list: Partial<ActivityInputs>) => activityGlyph(summarizeActivity(activityItems(inputs(list))));

    it("is the flame put out with nothing running", () => {
        expect(activityGlyph(EmptyActivity)).toBe("idle");
        expect(activityGlyph(null)).toBe("idle");
    });

    it("is the icon of the panel when one item runs: sparkles, the list, the hammer", () => {
        expect(glyphOf({ agents: agents(agent("working")) })).toBe("agent");
        expect(glyphOf({ work: [work("ci", 1)] })).toBe("ci");
        expect(glyphOf({ answers: { [Dir]: answer([pr(4, [check("pending")])]) } })).toBe("ci");
        expect(glyphOf({ work: [work("release", 1)] })).toBe("build");
        expect(ActivityGlyphIcons.agent).toBe("sparkles");
        expect(ActivityGlyphIcons.ci).toBe("list-check");
        expect(ActivityGlyphIcons.build).toBe("hammer");
    });

    it("is the flame lit when several items run, of one kind or of several", () => {
        expect(glyphOf({ agents: agents(agent("working"), agent("working")) })).toBe("fire");
        expect(glyphOf({ agents: agents(agent("working")), work: [work("build", 1)] })).toBe("fire");
        expect(ActivityGlyphIcons.fire).toBe("fire");
        expect(ActivityGlyphIcons.idle).toBe("fire");
    });
});

describe("the popover", () => {
    // Words that show the key, the count and the variables, as an age that shows its start.
    const words: ActivityWords = {
        t: fakeT,
        tc: fakeTc,
        now: 1_000_000,
        age: (startedat, now) => `${Math.round((now - startedat) / 1000)}s`,
        server: (text, english) => (text?.code ? `[${text.code}]` : english),
    };

    it("titles itself by how many items run", () => {
        expect(activityPopoverTitle(EmptyActivity, fakeT)).toBe("activity.popover.idle");
        const one = summarizeActivity(activityItems(inputs({ work: [work("build", 1)] })));
        expect(activityPopoverTitle(one, fakeT)).toBe("activity.popover.one");
        const two = summarizeActivity(activityItems(inputs({ work: [work("build", 1), work("ci", 2)] })));
        expect(activityPopoverTitle(two, fakeT)).toBe('activity.popover.many{"count":2}');
    });

    it("groups the rows as agents, CI, builds, newest first, and leaves out a group with nothing", () => {
        const summary = summarizeActivity(
            activityItems(
                inputs({
                    agents: agents(
                        agent("working", { started: 900_000, firstname: "Flore", message: "fixing #2233" }),
                        agent("working", { started: 800_000, firstname: "Berenice", message: "" })
                    ),
                    work: [work("build", 940_000, { title: "Gold packaging", detail: "pack" })],
                })
            )
        );
        const groups = activityGroups(summary, words);
        expect(groups.map((g) => g.id)).toEqual(["agents", "builds"]);
        expect(groups[0].title).toBe("activity.group.agents:2");
        expect(groups[0].rows.map((r) => [r.what, r.detail, r.since])).toEqual([
            ["Flore", "fixing #2233", "100s"],
            ["Berenice", "", "200s"],
        ]);
        expect(groups[1].title).toBe("activity.group.builds:1");
        expect(groups[1].rows[0]).toMatchObject({ what: "Gold packaging", detail: "pack", since: "60s" });
        expect(activityGroups(EmptyActivity, words)).toEqual([]);
    });

    it("words a local CI run with its job and share, and a pull request with its checks", () => {
        const summary = summarizeActivity(
            activityItems(
                inputs({
                    work: [work("ci", 970_000, { detail: "tests", progress: 0.43 })],
                    answers: {
                        [Dir]: answer([
                            pr(2227, [
                                check("success"),
                                check("success"),
                                check("pending", { startedat: "1970-01-01T00:16:00Z" }),
                            ]),
                        ]),
                    },
                })
            )
        );
        const [ci] = activityGroups(summary, words);
        expect(ci.id).toBe("ci");
        expect(ci.title).toBe("activity.group.ci");
        const byWhat = Object.fromEntries(ci.rows.map((r) => [r.what, r]));
        const local = byWhat["activity.row.localCi"];
        expect(local.detail).toBe('tests · activity.row.percent{"percent":43}');
        expect(local.since).toBe("30s");
        const remote = byWhat['activity.row.pr{"number":2227}'];
        expect(remote.detail).toBe('activity.row.prChecks{"done":2,"total":3}');
        expect(remote.target).toMatchObject({ type: "pr-ci", number: 2227 });
    });

    it("words an agent's line and a build's phase in the interface language when wavesrv sent a code", () => {
        const summary = summarizeActivity(
            activityItems(
                inputs({
                    agents: agents(agent("working", { message: "fixing", messagetext: { code: "agent.fixing" } })),
                    work: [work("build", 1, { detail: "preparing", detailtext: { code: "mission.work.preparing" } })],
                })
            )
        );
        const rows = activityGroups(summary, words).flatMap((g) => g.rows);
        expect(rows.map((r) => r.detail).sort()).toEqual(["[agent.fixing]", "[mission.work.preparing]"]);
    });

    it("says nothing of a start it does not know", () => {
        const summary = summarizeActivity(activityItems(inputs({ agents: agents(agent("working")) })));
        expect(activityGroups(summary, words)[0].rows[0].since).toBe("");
    });
});

describe("the words", () => {
    it("lists what runs, one line per sort: agents, CI of the pull requests, local CI, builds", () => {
        const summary = summarizeActivity(
            activityItems(
                inputs({
                    agents: agents(agent("working"), agent("working")),
                    work: [work("build", 1), work("ci", 2)],
                    answers: { [Dir]: answer([pr(12, [check("pending")])]) },
                })
            )
        );
        expect(activityLines(summary, fakeTc)).toEqual([
            "activity.agents:2",
            'activity.prCi:1{"numbers":"#12"}',
            "activity.localCi:1",
            "activity.builds:1",
        ]);
    });

    it("names the pull requests by number in order, and counts the rest", () => {
        const many = [30, 7, 21, 4, 99].map((n) => pr(n, [check("pending")]));
        const summary = summarizeActivity(activityItems(inputs({ answers: { [Dir]: answer(many) } })));
        expect(NamedPrs).toBe(3);
        expect(activityLines(summary, fakeTc)).toEqual(['activity.prCi:5{"numbers":"#4, #7, #21 +2"}']);
    });

    it("names what runs in the accessible name of the indicator, and says when nothing does", () => {
        const summary = summarizeActivity(
            activityItems(inputs({ agents: agents(agent("working", { started: 5 })), work: [work("build", 9)] }))
        );
        const texts = activityTexts(summary, fakeT, fakeTc);
        expect(texts.list).toBe("activity.agents:1, activity.builds:1");
        expect(texts.label).toBe('activity.label{"list":"activity.agents:1, activity.builds:1"}');
        expect(activityTexts(EmptyActivity, fakeT, fakeTc)).toEqual({ list: "", label: "activity.idle" });
        expect(activityLines(EmptyActivity, fakeTc)).toEqual([]);
    });

    it("says where a click on a row goes, in the row's tooltip", () => {
        expect(activityWhereKey({ type: "agent", blockid: "b" })).toBe("activity.open.agent");
        expect(activityWhereKey({ type: "build", dir: Dir })).toBe("activity.open.build");
        expect(activityWhereKey({ type: "local-ci", dir: Dir })).toBe("activity.open.localCi");
        expect(activityWhereKey({ type: "pr-ci", dir: Dir, number: 1 })).toBe("activity.open.prCi");
        expect(activityWhereKey(null)).toBe("");
    });

    it("has the keys it asks for in both languages, with the same variables", () => {
        const plural = [
            "agents",
            "subagents",
            "builds",
            "localCi",
            "prCi",
            "group.agents",
            "group.builds",
            "row.subagents",
        ];
        const text = [
            "label",
            "waitingLabel",
            "idle",
            "popover.idle",
            "popover.one",
            "popover.many",
            "popover.waiting",
            "popover.none",
            "group.ci",
            "group.waiting",
            "row.localCi",
            "row.pr",
            "row.prChecks",
            "row.percent",
            "row.asks",
            "open.waiting",
            "open.agent",
            "open.build",
            "open.localCi",
            "open.prCi",
        ];
        const get = (dict: any, path: string) => path.split(".").reduce((node, part) => node?.[part], dict.activity);
        const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        for (const dict of [enLocale as any, frLocale as any]) {
            for (const key of plural) {
                expect(typeof get(dict, `${key}.one`), key).toBe("string");
                expect(typeof get(dict, `${key}.other`), key).toBe("string");
            }
            for (const key of text) {
                expect(typeof get(dict, key), key).toBe("string");
            }
        }
        for (const key of [...text, ...plural.flatMap((k) => [`${k}.one`, `${k}.other`])]) {
            const en = get(enLocale, key);
            if (typeof en === "string") {
                expect(vars(get(frLocale, key)), key).toEqual(vars(en));
            }
        }
        expect(get(enLocale, "label")).toContain("{list}");
        expect(get(enLocale, "waitingLabel")).toContain("{list}");
        expect(get(enLocale, "row.asks")).toContain("{name}");
        expect(get(enLocale, "row.subagents.other")).toContain("{count}");
        expect(get(enLocale, "prCi.one")).toContain("{numbers}");
        expect(get(enLocale, "agents.other")).toContain("{count}");
        expect(get(enLocale, "popover.many")).toContain("{count}");
        expect(get(enLocale, "popover.none")).toBe("No agent, build or CI is running.");
        expect(get(frLocale, "popover.none")).toBe("Aucun agent, build ni CI en cours.");
        expect(get(frLocale, "popover.idle")).toBe("Les fourneaux sont éteints");
    });
});

function sub(parent: string, state: string, more: Partial<BranchAgent> = {}): BranchAgent {
    return {
        branch: "",
        worktree: "",
        kind: "subagent",
        parentblockid: parent,
        state: state as BranchAgent["state"],
        agentid: `${parent}:${state}:${more.description ?? ""}`,
        ...more,
    };
}

function upcoming(...list: BranchAgent[]): Record<string, UpcomingAnswer> {
    return { [Dir]: { dir: Dir, branches: [], agents: list, at: 1 } };
}

function summaryOf(more: Partial<ActivityInputs>) {
    const i = inputs(more);
    return summarizeActivity(activityItems(i), activityWaiting(i));
}

describe("the sub-agents of an agent of the workspace (#2294)", () => {
    const lead = (more: Partial<AgentStateInfo> = {}) => agent("idle", { started: 10, firstname: "Flore", ...more });

    it("runs while an idle lead's two background sub-agents work: one item, the lead, with their count", () => {
        const flore = lead();
        const summary = summaryOf({
            agents: agents(flore),
            upcoming: upcoming(
                sub(flore.blockid, "running", { description: "a" }),
                sub(flore.blockid, "running", { description: "b" })
            ),
        });
        expect(summary.count).toBe(1);
        expect(summary.kinds).toEqual({ agent: 1, build: 0, ci: 0 });
        expect(summary.subagents).toBe(2);
        expect(summary.items[0]).toMatchObject({
            id: `agent:${flore.blockid}`,
            kind: "agent",
            startedat: 10,
            target: { type: "agent", blockid: flore.blockid, workspaceid: "ws-1" },
            about: { title: "Flore", subagents: 2 },
        });
        expect(activityGlyph(summary)).toBe("agent");
    });

    it("goes out when they stop: quiet and finished sub-agents run nothing", () => {
        const flore = lead();
        const stopped = summaryOf({
            agents: agents(flore),
            upcoming: upcoming(sub(flore.blockid, "quiet"), sub(flore.blockid, "done", { description: "x" })),
        });
        expect(stopped).toBe(EmptyActivity);
        expect(activityGlyph(stopped)).toBe("idle");
    });

    it("counts a sub-agent whose state wavesrv does not name, as the Integration panel shows it", () => {
        const flore = lead();
        expect(summaryOf({ agents: agents(flore), upcoming: upcoming(sub(flore.blockid, "")) }).subagents).toBe(1);
        expect(subagentIsRunning("running")).toBe(true);
        expect(subagentIsRunning("")).toBe(true);
        expect(subagentIsRunning("quiet")).toBe(false);
        expect(subagentIsRunning("done")).toBe(false);
    });

    it("never counts the sub-agents of another workspace's lead, of Brokk's own session, or of a lead it does not know", () => {
        const far = lead({ workspaceid: "ws-b" });
        const brokk = lead({ own: true });
        const unplaced = lead({ workspaceid: undefined });
        const summary = summaryOf({
            agents: agents(far, brokk, unplaced),
            upcoming: upcoming(
                sub(far.blockid, "running"),
                sub(brokk.blockid, "running"),
                sub(unplaced.blockid, "running"),
                sub("closed-block", "running")
            ),
        });
        expect(summary).toBe(EmptyActivity);
        expect(
            summaryOf({ agents: agents(lead()), workspaceid: "ws-b", upcoming: upcoming(sub("x", "running")) })
        ).toBe(EmptyActivity);
    });

    it("reads the upcoming work of the workspace's projects only, and counts a sub-agent that every project lists once", () => {
        const flore = lead();
        const shared = sub(flore.blockid, "running", { agentid: "same" });
        const answers = {
            [Dir]: { dir: Dir, branches: [], agents: [shared], at: 1 },
            "/work/other": { dir: "/work/other", branches: [], agents: [shared], at: 1 },
            "/work/far": {
                dir: "/work/far",
                branches: [],
                agents: [sub(flore.blockid, "running", { agentid: "far" })],
                at: 1,
            },
        };
        const two = summaryOf({ agents: agents(flore), upcoming: answers, dirs: [Dir, "/work/other"] });
        expect(two.subagents).toBe(1);
    });

    it("tells two sub-agents without an id apart by their task and place", () => {
        const flore = lead();
        const a = sub(flore.blockid, "running", { agentid: "", description: "a", branch: "fix/1-a" });
        const b = sub(flore.blockid, "running", { agentid: "", description: "b", branch: "fix/2-b" });
        expect(summaryOf({ agents: agents(flore), upcoming: upcoming(a, b) }).subagents).toBe(2);
    });

    it("counts a working lead once, with its sub-agents, and takes the larger count its hooks report", () => {
        const flore = lead({ state: "working", subagents: 3, background: true, message: "3 sub-agents running" });
        const summary = summaryOf({
            agents: agents(flore),
            upcoming: upcoming(sub(flore.blockid, "running", { description: "a" })),
        });
        expect(summary.count).toBe(1);
        expect(summary.subagents).toBe(3);
        expect(summary.items[0].about.detail).toBe("");
    });

    it("keeps a working lead's own line when it works by itself", () => {
        const flore = lead({ state: "working", message: "fixing #2294" });
        const [item] = activityItems(inputs({ agents: agents(flore) }));
        expect(item.about).toMatchObject({ detail: "fixing #2294", subagents: 0 });
    });

    it("words the lead with its sub-agents in the popover, in the agents' group, and in the accessible name", () => {
        const flore = lead({ state: "working", message: "reading", started: 900_000 });
        const summary = summaryOf({
            agents: agents(flore),
            upcoming: upcoming(
                sub(flore.blockid, "running", { description: "a" }),
                sub(flore.blockid, "running", { description: "b" })
            ),
        });
        const words: ActivityWords = {
            t: fakeT,
            tc: fakeTc,
            now: 1_000_000,
            age: (startedat, now) => `${Math.round((now - startedat) / 1000)}s`,
            server: (_text, english) => english,
        };
        const [agents_] = activityGroups(summary, words);
        expect(agents_.id).toBe("agents");
        expect(agents_.rows.map((r) => [r.what, r.detail, r.since, r.whereKey])).toEqual([
            ["Flore", "reading · activity.row.subagents:2", "100s", "activity.open.agent"],
        ]);
        expect(activityLines(summary, fakeTc)).toEqual(["activity.agents:1", "activity.subagents:2"]);
        expect(activityTexts(summary, fakeT, fakeTc).list).toBe("activity.agents:1, activity.subagents:2");
    });

    it("has the sub-agents in the key, so a lead that gains one draws again", () => {
        const flore = lead();
        const one = summaryOf({
            agents: agents(flore),
            upcoming: upcoming(sub(flore.blockid, "running", { description: "a" })),
        });
        const two = summaryOf({
            agents: agents(flore),
            upcoming: upcoming(
                sub(flore.blockid, "running", { description: "a" }),
                sub(flore.blockid, "running", { description: "b" })
            ),
        });
        expect(activityKey(one)).not.toBe(activityKey(two));
    });

    it("keeps the same summary of agents and key when only an unrelated sub-agent of the list changes state", () => {
        const flore = lead();
        const before = summaryOf({
            agents: agents(flore),
            upcoming: upcoming(
                sub(flore.blockid, "running", { description: "a" }),
                sub(flore.blockid, "done", { description: "b" })
            ),
        });
        const after = summaryOf({
            agents: agents(flore),
            upcoming: upcoming(
                sub(flore.blockid, "running", { description: "a" }),
                sub(flore.blockid, "quiet", { description: "b" })
            ),
        });
        expect(activityKey(after)).toBe(activityKey(before));
    });
});

describe("an agent that waits for the developer (#2294)", () => {
    const asking = (more: Partial<AgentStateInfo> = {}) =>
        agent("waiting", { firstname: "Flore", since: 5000, tabid: "tab-x", ...more });

    it("is a state of its own, not running work: no item, no count, the glyph of a waiting agent", () => {
        const flore = asking();
        const summary = summaryOf({ agents: agents(flore), tabNames: { "tab-x": "Cadrage" } });
        expect(summary.count).toBe(0);
        expect(summary.items).toEqual([]);
        expect(summary.lead).toBeNull();
        expect(summary.waiting).toEqual([
            {
                id: `waiting:${flore.blockid}`,
                name: "Flore",
                place: "Cadrage",
                detail: "",
                detailtext: undefined,
                since: 5000,
                target: { type: "agent", blockid: flore.blockid, tabid: "tab-x", workspaceid: "ws-1" },
            },
        ]);
        expect(activityGlyph(summary)).toBe("wait");
        expect(ActivityGlyphIcons.wait).toBe(ActivityGlyphIcons.agent);
    });

    it("leaves out another workspace's waiting agent, Brokk's own session, and an agent whose workspace is unknown", () => {
        const summary = summaryOf({
            agents: agents(
                asking({ workspaceid: "ws-b" }),
                asking({ own: true }),
                asking({ workspaceid: undefined }),
                agent("waiting", { agent: "", agentname: "" })
            ),
        });
        expect(summary).toBe(EmptyActivity);
    });

    it("shows work that runs and an answer awaited at the same time", () => {
        const summary = summaryOf({ agents: agents(asking()), work: [work("build", 9)] });
        expect(summary.count).toBe(1);
        expect(summary.waiting).toHaveLength(1);
        expect(activityGlyph(summary)).toBe("build");
    });

    it("lists the agent that has waited longest first, one that does not say since last", () => {
        const late = asking({ firstname: "Late", since: 9000 });
        const early = asking({ firstname: "Early", since: 1000 });
        const unknown = asking({ firstname: "Unknown", since: undefined });
        const summary = summaryOf({ agents: agents(late, unknown, early) });
        expect(summary.waiting.map((w) => w.name)).toEqual(["Early", "Late", "Unknown"]);
    });

    it("names the agent by its tool without a first name, and leaves the place empty without a tab name", () => {
        const [w] = summaryOf({ agents: agents(asking({ firstname: undefined, tabid: undefined })) }).waiting;
        expect(w.name).toBe("Claude Code");
        expect(w.place).toBe("");
    });

    it("words its row 'Flore asks you something · Cadrage', first in the popover, with how long it has waited", () => {
        const summary = summaryOf({
            agents: agents(asking()),
            tabNames: { "tab-x": "Cadrage" },
            work: [work("build", 940_000)],
        });
        const words: ActivityWords = {
            t: fakeT,
            tc: fakeTc,
            now: 1_000_000,
            age: (startedat, now) => `${Math.round((now - startedat) / 1000)}s`,
            server: (_text, english) => english,
        };
        const groups = activityGroups(summary, words);
        expect(groups.map((g) => g.id)).toEqual(["waiting", "builds"]);
        expect(groups[0].title).toBe("activity.group.waiting");
        expect(groups[0].rows).toEqual([
            {
                id: summary.waiting[0].id,
                what: 'activity.row.asks{"name":"Flore"}',
                detail: "Cadrage",
                since: "995s",
                target: summary.waiting[0].target,
                whereKey: "activity.open.waiting",
            },
        ]);
    });

    it("titles the popover and names the indicator by what waits when nothing runs, and by both when both", () => {
        const waiting = summaryOf({ agents: agents(asking(), asking({ firstname: "Berenice" })) });
        expect(activityPopoverTitle(waiting, fakeT)).toBe("activity.popover.waiting");
        expect(activityTexts(waiting, fakeT, fakeTc)).toEqual({
            list: "",
            label: 'activity.waitingLabel{"list":"Flore, Berenice"}',
        });
        const both = summaryOf({ agents: agents(asking()), work: [work("build", 9)] });
        expect(activityPopoverTitle(both, fakeT)).toBe("activity.popover.one");
        expect(activityTexts(both, fakeT, fakeTc).label).toBe(
            'activity.label{"list":"activity.builds:1"}. activity.waitingLabel{"list":"Flore"}'
        );
    });

    it("has the waiting agents in the key, so a new question or a moved tab draws again", () => {
        const flore = asking();
        const a = summaryOf({ agents: agents(flore), tabNames: { "tab-x": "Cadrage" } });
        const b = summaryOf({ agents: agents(flore), tabNames: { "tab-x": "Review" } });
        expect(activityKey(a)).not.toBe(activityKey(b));
        expect(activityKey(a)).not.toBe(activityKey(EmptyActivity));
        expect(
            activityKey(summaryOf({ agents: agents({ ...flore, version: 99 }), tabNames: { "tab-x": "Cadrage" } }))
        ).toBe(activityKey(a));
    });
});

describe("the agents that make the upcoming work worth asking (#2294)", () => {
    it("is empty with no agent open, and changes when an agent of the workspace opens or closes", () => {
        const flore = agent("idle", { started: 10 });
        expect(openAgentsKey({}, "ws-1")).toBe("");
        const open = openAgentsKey(agents(flore), "ws-1");
        expect(open).toBe(`${flore.blockid}@10`);
        expect(openAgentsKey(agents(flore, agent("idle", { started: 20 })), "ws-1")).not.toBe(open);
    });

    it("ignores the states, the versions, other workspaces' agents, Brokk's session, and every agent without a workspace", () => {
        const flore = agent("idle", { started: 10 });
        const open = openAgentsKey(agents(flore), "ws-1");
        expect(openAgentsKey(agents({ ...flore, state: "working", version: 9 }), "ws-1")).toBe(open);
        expect(
            openAgentsKey(agents(agent("idle", { workspaceid: "ws-b" }), agent("idle", { own: true })), "ws-1")
        ).toBe("");
        expect(openAgentsKey(agents(flore), "")).toBe("");
    });
});
