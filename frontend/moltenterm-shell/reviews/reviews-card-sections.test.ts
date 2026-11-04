// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #1876, FR-REV-001 AC16 to AC18, FR-REV-022 AC20: the sections are by what the developer must do (a blocker, ready,
// running, settled), a settled stop leaves "Needs you", and every card has one status line that is true: what runs
// now, or "Nothing runs" and why. Times are given, never read from the clock.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import { I18nModel } from "../i18n/i18n";
import { wordPhrase } from "../i18n/phrase";
import { CardInput, cardState, CardTurn, settledPhrase } from "./reviews-card-model";
import type { ReviewCheck, ReviewPr } from "./reviews-model";
import { CardContext, cardStates, sectionsByTurn } from "./reviews-sections-model";
import type { AgentBarFacts, UpcomingAnswer } from "./reviews-upcoming-model";

const Minute = 60_000;
const Start = Date.parse("2026-11-04T10:00:00Z");

const Done = (name: string, state: ReviewCheck["state"] = "success", completedat = ""): ReviewCheck => ({
    name,
    state,
    completedat: completedat || undefined,
});
const Green: ReviewCheck[] = ["Build", "Frontend", "Lint", "Docs", "Gate"].map((n) => Done(n));

function pr(over: Partial<ReviewPr> = {}, checks: ReviewCheck[] = Green): ReviewPr {
    const count = (s: string) => checks.filter((c) => c.state === s).length;
    const failure = count("failure");
    const pending = count("pending");
    return {
        number: 1872,
        title: "Make the Integration panel say what it does",
        url: "https://github.com/acme/app/pull/1872",
        branch: "feature/1872-needs-you",
        base: "develop",
        headoid: "abc1234",
        createdat: "",
        updatedat: "",
        merge: "clean",
        ci: {
            state: failure > 0 ? "failure" : pending > 0 ? "pending" : checks.length > 0 ? "success" : "none",
            success: count("success"),
            failure,
            pending,
            checks,
        },
        report: { state: "present" },
        unpublished: 0,
        ...over,
    };
}

const BackendRunning: ReviewCheck = {
    name: "Backend",
    state: "pending",
    startedat: new Date(Start).toISOString(),
};

function agent(over: Partial<AgentBarFacts>): AgentBarFacts {
    return { kind: "panel", blockId: "b", name: "Julien", state: "idle", since: 1, ...over };
}

const Waiting = agent({
    state: "waiting",
    held: {
        text: { code: "notif.review.asks", vars: { reason: "Backend stays red" } },
        english: "stopped for a decision",
    },
});
const Settled = agent({ settled: { by: "Arthur", note: "Backend is flaky, #1874 fixes it", at: Start } });

function card(input: Partial<CardInput> & { pr: ReviewPr }, now = Start) {
    return cardState({ agents: [], now, ...input });
}

function line(input: Partial<CardInput> & { pr: ReviewPr }, now = Start): string {
    return wordPhrase(card(input, now).status.line);
}

describe("the sections: what the developer must do (#1876)", () => {
    const Section: [string, Partial<CardInput> & { pr: ReviewPr }, CardTurn][] = [
        ["a question nobody settled", { pr: pr(), agents: [Waiting] }, "yours"],
        ["conflicts with the base", { pr: pr({ merge: "conflicts" }) }, "yours"],
        [
            "CI red on the PR's own check",
            { pr: pr({ merge: "failing" }, [Done("Backend", "failure"), ...Green]) },
            "yours",
        ],
        ["the merge queue stopped on it", { pr: pr(), batchStopped: true }, "yours"],
        [
            "required checks or an approval missing",
            { pr: pr({ merge: "blocked", reviewdecision: "REVIEW_REQUIRED" }) },
            "yours",
        ],
        ["a local CI waiting for approval", { pr: pr({}, [Done("Local CI", "untrusted"), ...Green]) }, "yours"],
        ["a draft to test (the Human Testing gate)", { pr: pr({ draft: true }) }, "yours"],
        ["ready, CI green, nothing open", { pr: pr() }, "ready"],
        ["CI running", { pr: pr({}, [BackendRunning, ...Green]) }, "waiting"],
        ["an agent working", { pr: pr(), agents: [agent({ state: "working" })] }, "waiting"],
        ["GitHub computing the merge", { pr: pr({ merge: "unknown" }) }, "waiting"],
        [
            "a draft left to its agent that stopped",
            { pr: pr({ draft: true }), agents: [agent({})], agentReadies: true },
            "agents",
        ],
        [
            "a draft held until another PR merges",
            {
                pr: pr({ draft: true }),
                agents: [agent({})],
                agentReadies: true,
                waitsOn: [{ number: 1871, kind: "pr", state: "open", from: "body" }],
            },
            "agents",
        ],
    ];

    it.each(Section)("%s", (_name, input, turn) => {
        expect(card(input).turn).toBe(turn);
    });

    it("the merge queue's stop is the card's state, with the row under it carrying the action", () => {
        const s = card({ pr: pr(), batchStopped: true });
        expect([s.kind, s.molten, s.primary]).toEqual(["queue-stopped", false, null]);
        expect(wordPhrase(s.sentence)).toBe("The merge queue stopped on it");
    });

    it("an unsettled stop wins over a green PR; settled, the PR is ready again", () => {
        expect(card({ pr: pr(), agents: [Waiting] }).turn).toBe("yours");
        const settled = card({ pr: pr(), agents: [Settled] });
        expect([settled.kind, settled.turn]).toEqual(["ready", "ready"]);
    });

    it("a settled stop whose CI still runs goes to In progress, not to Needs you", () => {
        const settled = card({ pr: pr({}, [BackendRunning, ...Green]), agents: [Settled] });
        expect([settled.kind, settled.turn, settled.works]).toEqual(["ci-running", "waiting", true]);
    });
});

describe("a settled stop keeps one muted line (#1876, FR-REV-022 AC20)", () => {
    it("names who settled it and why", () => {
        const s = card({ pr: pr(), agents: [Settled] });
        expect(wordPhrase(settledPhrase(s.settled))).toBe("settled by Arthur: Backend is flaky, #1874 fixes it");
    });

    it("says 'you' when the developer did it, and leaves out a missing note", () => {
        const you = card({ pr: pr(), agents: [agent({ settled: { by: "", note: "marked ready", at: Start } })] });
        expect(wordPhrase(settledPhrase(you.settled))).toBe("settled by you: marked ready");
        const bare = card({ pr: pr(), agents: [agent({ settled: { by: "Arthur", note: "", at: Start } })] });
        expect(wordPhrase(settledPhrase(bare.settled))).toBe("settled by Arthur");
    });

    it("an agent that waits is not settled, and there is no line", () => {
        expect(card({ pr: pr(), agents: [Waiting] }).settled).toBeUndefined();
        expect(settledPhrase(undefined)).toBeNull();
    });

    it("the developer can settle a stop MoltenTerm holds, never an agent's own prompt", () => {
        const held = card({ pr: pr(), agents: [Waiting] });
        expect(held.menu.map((a) => a.id)).toContain("settle");
        expect(held.menu.find((a) => a.id === "settle").blockId).toBe("b");
        const own = card({ pr: pr(), agents: [agent({ state: "waiting" })] });
        expect(own.menu.map((a) => a.id)).not.toContain("settle");
    });
});

describe("the status line is true (#1876, FR-REV-001 AC17)", () => {
    it("says what runs and for how long while a check runs", () => {
        const checks = [BackendRunning, ...Green];
        expect(line({ pr: pr({}, checks) }, Start + 6 * Minute + 30_000)).toBe("CI running · 5/6 · Backend · 6 min");
        expect(card({ pr: pr({}, checks) }).status.running).toBe(true);
    });

    it("says it without a duration when GitHub gave no start", () => {
        expect(line({ pr: pr({}, [{ name: "Backend", state: "pending" }, ...Green]) })).toBe(
            "CI running · 5/6 · Backend"
        );
    });

    it("uses the oldest start of the checks that run", () => {
        const later = {
            name: "Frontend2",
            state: "pending" as const,
            startedat: new Date(Start + 4 * Minute).toISOString(),
        };
        expect(line({ pr: pr({}, [later, BackendRunning, ...Green]) }, Start + 6 * Minute)).toBe(
            "CI running · 5/7 · Frontend2, Backend · 6 min"
        );
    });

    it("never reads idle while CI runs, whatever the section", () => {
        const running = pr({}, [BackendRunning, ...Green]);
        for (const input of [
            { pr: { ...running, merge: "conflicts" as const } },
            { pr: running, agents: [Waiting] },
            { pr: { ...running, draft: true }, agents: [agent({})], agentReadies: true },
            { pr: running, batchStopped: true },
            { pr: { ...running, merge: "blocked" as const, reviewdecision: "REVIEW_REQUIRED" } },
        ]) {
            const s = card(input, Start + Minute);
            expect([s.status.running, s.works, wordPhrase(s.status.line).startsWith("Nothing runs")]).toEqual([
                true,
                true,
                false,
            ]);
        }
    });

    it("never looks busy when nothing runs: it says so and why", () => {
        expect(line({ pr: pr(), agents: [Waiting] })).toBe("Nothing runs · Julien waits for your answer");
        expect(line({ pr: pr({ merge: "conflicts" }) })).toBe("Nothing runs · conflicts with develop");
        expect(line({ pr: pr(), batchStopped: true })).toBe("Nothing runs · the merge queue stopped on it");
        expect(line({ pr: pr({ merge: "blocked", reviewdecision: "REVIEW_REQUIRED" }) })).toBe(
            "Nothing runs · waiting for an approval"
        );
        for (const input of [
            { pr: pr(), agents: [Waiting] },
            { pr: pr() },
            { pr: pr({ draft: true }), agents: [agent({})], agentReadies: true },
            { pr: pr({ merge: "conflicts" }) },
        ]) {
            const s = card(input);
            expect([s.status.running, s.works, s.motion]).toEqual([false, false, null]);
        }
    });

    it("says since when a red CI is over: 'CI finished 3 h ago, red on Backend'", () => {
        const ended = new Date(Start).toISOString();
        const failed = pr({ merge: "failing" }, [Done("Backend", "failure", ended), ...Green]);
        expect(line({ pr: failed }, Start + 3 * 60 * Minute + 5 * Minute)).toBe(
            "Nothing runs · CI finished 3 h 05 ago, red on Backend"
        );
        expect(line({ pr: pr({ merge: "failing" }, [Done("Backend", "failure"), ...Green]) })).toBe(
            "Nothing runs · CI finished, red on Backend"
        );
    });

    it("says since when a green CI is over, for a ready PR and a draft to test", () => {
        const ended = new Date(Start).toISOString();
        const green = pr({}, [Done("Build", "success", ended), ...Green.slice(1)]);
        expect(line({ pr: green }, Start + 12 * Minute)).toBe("Nothing runs · CI finished 12 min ago, green");
        expect(line({ pr: { ...green, draft: true } }, Start + 12 * Minute)).toBe(
            "Nothing runs · draft to test · CI finished 12 min ago, green"
        );
    });

    it("says an agent at work and since when, the agent's line keeping the dominoes", () => {
        const working = agent({ state: "working", since: Start });
        const s = card({ pr: pr(), agents: [working] }, Start + 4 * Minute);
        expect(wordPhrase(s.status.line)).toBe("Julien is working on it · 4 min");
        expect([s.works, s.motion]).toEqual([true, "agent"]);
    });

    it("says an agent inferred from the board column, without a duration", () => {
        const s = card({ pr: pr({ draft: true }), boardTurn: { owner: "agent", kind: "agent" } });
        expect(wordPhrase(s.status.line)).toBe("An agent is probably working on it");
        expect(s.motion).toBe("state");
    });

    it("says GitHub is checking the merge while it computes it", () => {
        expect(line({ pr: pr({ merge: "unknown" }) })).toBe("GitHub is checking the merge");
    });

    it("says what a draft left to its agent waits for", () => {
        expect(line({ pr: pr({ draft: true }), agents: [agent({})], agentReadies: true })).toBe(
            "Nothing runs · Julien stopped before marking it ready"
        );
        expect(
            line({
                pr: pr({ draft: true }),
                agents: [agent({})],
                agentReadies: true,
                waitsOn: [{ number: 1871, kind: "pr", state: "open", from: "body" }],
            })
        ).toBe("Nothing runs · waiting for #1871 to merge");
    });
});

// The windows' agent state carries the settlement (wavesrv sets it, pkg/molten/attention/agenthold.go): from that
// state to the section, through the placement of the agent on the PR's branch.
describe("from the agent's state to the section (#1876)", () => {
    const Held = { code: "notif.review.asks", vars: { reason: "Backend stays red" } };
    const Upcoming: UpcomingAnswer = {
        dir: "/p",
        branches: [],
        agents: [
            { branch: "feature/1872-needs-you", worktree: "/w/1872", kind: "panel", blockid: "julien", started: 1 },
        ],
        drafts: [],
        at: Start,
    };
    const ctx = (info: Record<string, unknown>): CardContext => ({
        upcoming: Upcoming,
        states: {
            states: { julien: { blockid: "julien", firstname: "Julien", since: 1, ...info } },
        } as unknown as AgentStatesData,
        now: Start + Minute,
        boardText: (s) => s,
    });
    const sectionOfCard = (prs: ReviewPr[], info: Record<string, unknown>) => {
        const cards = cardStates(prs, {}, (n) => `/p#${n}`, ctx(info));
        return sectionsByTurn(prs, cards, "state").map((s) => [s.turn, s.prs.map((p) => p.number)]);
    };

    it("a stop held for a decision is Needs you; once settled the PR goes to its own section with the muted line", () => {
        const held = { state: "waiting", message: "stopped for a decision: Backend stays red", messagetext: Held };
        expect(sectionOfCard([pr()], held)).toEqual([["yours", [1872]]]);
        const settled = {
            state: "idle",
            settled: { by: "Arthur", note: "Backend is flaky, #1874 fixes it", at: Start },
        };
        expect(sectionOfCard([pr()], settled)).toEqual([["ready", [1872]]]);
        const cards = cardStates([pr()], {}, (n) => `/p#${n}`, ctx(settled));
        expect(cards[1872].agent).toBeUndefined();
        expect(wordPhrase(settledPhrase(cards[1872].settled))).toBe(
            "settled by Arthur: Backend is flaky, #1874 fixes it"
        );
    });

    it("the incident: three PRs the agents stopped on, the lead settled them, #1874 fixed the flake, CI still runs", () => {
        const running = (n: number) => pr({ number: n, branch: `feature/${n}-x` }, [BackendRunning, ...Green]);
        const prs = [running(1872), running(1865), running(1869)];
        const states = {
            states: Object.fromEntries(
                [1872, 1865, 1869].map((n) => [
                    `b${n}`,
                    {
                        blockid: `b${n}`,
                        firstname: `Agent${n}`,
                        since: 1,
                        state: "idle",
                        settled: { by: "Arthur", note: "go on", at: Start },
                    },
                ])
            ),
        } as unknown as AgentStatesData;
        const upcoming: UpcomingAnswer = {
            ...Upcoming,
            agents: [1872, 1865, 1869].map((n) => ({
                branch: `feature/${n}-x`,
                worktree: `/w/${n}`,
                kind: "panel" as const,
                blockid: `b${n}`,
                started: 1,
            })),
        };
        const cards = cardStates(prs, {}, (n) => `/p#${n}`, { ...ctx({}), upcoming, states });
        expect(sectionsByTurn(prs, cards, "state").map((s) => [s.turn, s.prs.length])).toEqual([["waiting", 3]]);
        expect(prs.every((p) => cards[p.number].status.running && cards[p.number].settled?.by === "Arthur")).toBe(true);
    });

    it("a PR found ready on GitHub settles nothing by itself (FR-REV-001 AC18)", () => {
        const held = { state: "waiting", message: "stopped for a decision", messagetext: Held };
        expect(sectionOfCard([pr({ draft: false })], held)).toEqual([["yours", [1872]]]);
    });
});

describe("in French", () => {
    beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("words the sections' status lines and the settled line", () => {
        const checks = [BackendRunning, ...Green];
        expect(line({ pr: pr({}, checks) }, Start + 6 * Minute)).toBe("CI en cours · 5/6 · Backend · 6 min");
        expect(line({ pr: pr(), agents: [Waiting] })).toBe("Rien ne tourne · Julien attend votre réponse");
        const ended = new Date(Start).toISOString();
        expect(
            line({ pr: pr({ merge: "failing" }, [Done("Backend", "failure", ended), ...Green]) }, Start + 185 * Minute)
        ).toBe("Rien ne tourne · CI terminée il y a 3 h 05, rouge sur Backend");
        expect(wordPhrase(settledPhrase(card({ pr: pr(), agents: [Settled] }).settled))).toBe(
            "réglé par Arthur : Backend is flaky, #1874 fixes it"
        );
    });
});
