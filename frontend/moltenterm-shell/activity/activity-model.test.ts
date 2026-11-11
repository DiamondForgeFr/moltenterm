// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The activity source's rules (FR-BOSS-009, AC85; FR-SHELL-122, #2233): what counts as running, per kind, which item
// leads, and the words that list it. Pure, so no window is needed.

import { describe, expect, it } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import enLocale from "../i18n/locales/en.json";
import frLocale from "../i18n/locales/fr.json";
import type { ReviewCheck, ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import type { WorkItem } from "../running-work";
import {
    ActivityInputs,
    activityItems,
    activityKey,
    activityLines,
    ActivityT,
    ActivityTCount,
    activityTexts,
    activityWhereKey,
    EmptyActivity,
    NamedPrs,
    summarizeActivity,
} from "./activity-model";

const Dir = "/work/product";

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
    return { agents: {}, work: [], answers: {}, dirs: [Dir], ...more };
}

describe("what runs: agents", () => {
    it("counts the agents that work, in every workspace, and no other state", () => {
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
        expect(items).toHaveLength(2);
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

    it("keeps the same key while the same items run, whatever else about them moved", () => {
        const a = agent("working", { started: 10 });
        const first = summarizeActivity(activityItems(inputs({ agents: agents(a) })));
        const again = summarizeActivity(
            activityItems(inputs({ agents: agents({ ...a, message: "thinking", version: 99 }) }))
        );
        expect(activityKey(again)).toBe(activityKey(first));
        const other = summarizeActivity(activityItems(inputs({ agents: agents(a, agent("working")) })));
        expect(activityKey(other)).not.toBe(activityKey(first));
    });
});

// A translation that shows the key, the count and the variables it was given.
const fakeT: ActivityT = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key);
const fakeTc: ActivityTCount = (key, count, vars) => `${key}:${count}${vars ? JSON.stringify(vars) : ""}`;

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

    it("says where a click goes, the lead's place, in the label and the tooltip", () => {
        const summary = summarizeActivity(
            activityItems(inputs({ agents: agents(agent("working", { started: 5 })), work: [work("build", 9)] }))
        );
        expect(summary.lead.kind).toBe("build");
        const texts = activityTexts(summary, fakeT, fakeTc);
        expect(texts.list).toBe("activity.agents:1, activity.builds:1");
        expect(texts.label).toBe('activity.label{"list":"activity.agents:1, activity.builds:1"}. activity.open.build');
        expect(texts.title).toBe("activity.agents:1\nactivity.builds:1\nactivity.open.build");
        expect(activityWhereKey({ type: "agent", blockid: "b" })).toBe("activity.open.agent");
        expect(activityWhereKey({ type: "local-ci", dir: Dir })).toBe("activity.open.localCi");
        expect(activityWhereKey({ type: "pr-ci", dir: Dir, number: 1 })).toBe("activity.open.prCi");
        expect(activityWhereKey(null)).toBe("");
    });

    it("has no words when nothing runs", () => {
        expect(activityTexts(EmptyActivity, fakeT, fakeTc)).toEqual({ list: "", label: "", title: "" });
        expect(activityLines(EmptyActivity, fakeTc)).toEqual([]);
    });

    it("has the keys it asks for in both languages, with the same variables", () => {
        const keys = ["agents", "builds", "localCi", "prCi"];
        for (const dict of [enLocale as any, frLocale as any]) {
            expect(typeof dict.activity.label).toBe("string");
            expect(dict.activity.label).toContain("{list}");
            for (const key of keys) {
                expect(typeof dict.activity[key].one, key).toBe("string");
                expect(typeof dict.activity[key].other, key).toBe("string");
            }
            for (const where of ["agent", "build", "localCi", "prCi"]) {
                expect(typeof dict.activity.open[where], where).toBe("string");
            }
            expect(dict.activity.prCi.one).toContain("{numbers}");
            expect(dict.activity.prCi.other).toContain("{numbers}");
            expect(dict.activity.agents.other).toContain("{count}");
        }
    });
});
