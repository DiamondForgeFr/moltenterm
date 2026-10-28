// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews card's one state (#1060, FR-REV-001 AC11): every state of the mockup's table, the precedence between
// them, the one primary action, the menu and the facts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { wordPhrase } from "../i18n/phrase";
import { CardInput, cardState, CardStateKind, CardStateKinds } from "./reviews-card-model";
import type { ReviewCheck, ReviewPr } from "./reviews-model";
import type { PrTask } from "./reviews-task-model";
import type { AgentBarFacts } from "./reviews-upcoming-model";

const Green: ReviewCheck[] = [
    { name: "Backend", state: "success" },
    { name: "Build", state: "success" },
    { name: "Frontend", state: "success" },
    { name: "Lint", state: "success" },
];

function pr(over: Partial<ReviewPr> = {}, checks: ReviewCheck[] = Green): ReviewPr {
    const count = (s: string) => checks.filter((c) => c.state === s).length;
    const failure = count("failure");
    const pending = count("pending");
    return {
        number: 1101,
        title: "Workspace colours from the logo",
        url: "https://github.com/acme/app/pull/1101",
        branch: "feature/1101-colours",
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

const Nathan: AgentBarFacts = { kind: "panel", blockId: "nathan", name: "Nathan", state: "working", since: 1 };
const Diane: AgentBarFacts = { kind: "panel", blockId: "diane", name: "Diane", state: "waiting", since: 1 };
const Jeanne: AgentBarFacts = { kind: "panel", blockId: "jeanne", name: "Jeanne", state: "idle", since: 1 };
const Background: AgentBarFacts = {
    kind: "background",
    name: "",
    state: "background",
    since: 1,
    parentBlockId: "salome",
    parentName: "Salomé",
};
const Rebase: PrTask = { kind: "rebase", name: "Jeanne", blockId: "jeanne", head: "abc1234", at: 1 };
const Fix: PrTask = { kind: "investigate", name: "Salomé", blockId: "salome", head: "abc1234", at: 1 };

const Failed = (name = "Backend"): ReviewCheck => ({ name, state: "failure", runid: 7 });

function state(input: Partial<CardInput> & { pr: ReviewPr }) {
    return cardState({ agents: [], ...input });
}

function words(input: Partial<CardInput> & { pr: ReviewPr }) {
    const s = state(input);
    return {
        kind: s.kind,
        sentence: wordPhrase(s.sentence),
        why: wordPhrase(s.why),
        primary: wordPhrase(s.primary?.label),
        molten: s.molten,
        menu: s.menu.map((a) => (a.disabled ? `${wordPhrase(a.label)} (off)` : wordPhrase(a.label))),
        facts: s.facts.map((f) => wordPhrase(f.text)),
        history: wordPhrase(s.history),
    };
}

// One case per state of the mockup, each the only thing that applies.
const Cases: { kind: CardStateKind; input: Partial<CardInput> & { pr: ReviewPr } }[] = [
    { kind: "agent-waiting", input: { pr: pr(), agents: [Diane] } },
    { kind: "agent-working", input: { pr: pr({ merge: "conflicts", draft: true }), agents: [Nathan] } },
    { kind: "agent-finish", input: { pr: pr({ draft: true }), agents: [Jeanne], agentReadies: true } },
    {
        kind: "interrupted",
        input: {
            pr: pr({ merge: "conflicts" }),
            agents: [Jeanne],
            task: Rebase,
            taskState: "stuck",
            taskOwner: Jeanne,
            taskLive: true,
        },
    },
    { kind: "conflicts", input: { pr: pr({ merge: "conflicts" }) } },
    { kind: "failing", input: { pr: pr({ merge: "failing" }, [Failed(), ...Green.slice(1)]), rerunnable: true } },
    { kind: "review-required", input: { pr: pr({ merge: "blocked", reviewdecision: "REVIEW_REQUIRED" }) } },
    { kind: "draft-ready", input: { pr: pr({ draft: true, report: { state: "missing" } }) } },
    {
        kind: "ci-running",
        input: {
            pr: pr({ merge: "behind" }, [
                { name: "Backend", state: "pending" },
                { name: "Build", state: "pending" },
                ...Green.slice(2),
            ]),
        },
    },
    { kind: "ready", input: { pr: pr() } },
];

describe("cardState: the nine states (#1060)", () => {
    it("covers every state of the table", () => {
        expect(Cases.map((c) => c.kind)).toEqual([...CardStateKinds]);
    });

    it.each(Cases)("$kind", ({ kind, input }) => {
        expect(state(input).kind).toBe(kind);
    });

    it("an agent waits: Answer {name}, molten, its work and Stop in the menu", () => {
        const w = words({ pr: pr(), agents: [Diane] });
        expect(w.sentence).toBe("Diane is waiting for you");
        expect(w.primary).toBe("Answer Diane");
        expect(w.molten).toBe(true);
        expect(w.menu).toEqual(["Open its work", "Stop Diane", "Open on GitHub"]);
        expect(state({ pr: pr(), agents: [Diane] }).primary.blockId).toBe("diane");
    });

    it("an agent on it: Follow {name}, calm; conflicts are its reason, not an alarm; Mark ready asks", () => {
        const s = state({ pr: pr({ merge: "conflicts", draft: true }), agents: [Nathan, Jeanne], task: Rebase });
        const w = words({ pr: pr({ merge: "conflicts", draft: true }), agents: [Nathan, Jeanne], task: Rebase });
        expect(w.sentence).toBe("Nathan is on it");
        expect(w.why).toBe("conflicts with develop");
        expect(w.primary).toBe("Follow Nathan");
        expect(s.molten).toBe(false);
        expect(s.tone).toBe("agent");
        expect(s.turn).toBe("agents");
        expect(w.facts).not.toContain("conflicts with develop");
        const ready = s.menu.find((a) => a.id === "mark-ready");
        expect(wordPhrase(ready.confirm)).toBe("Nathan is still working on this branch.");
        expect(w.menu).toEqual([
            "Mark ready for review: the PR leaves draft",
            "Open its work",
            "Stop Nathan",
            "Assisted review",
            "Launch this version",
            "Open on GitHub",
        ]);
    });

    it("an agent on its own task names it", () => {
        const task: PrTask = { kind: "rebase", name: "Simon", blockId: "nathan", head: "h", at: 1 };
        const w = words({
            pr: pr({ merge: "conflicts" }),
            agents: [Nathan],
            task,
            taskState: "running",
            taskOwner: Nathan,
        });
        expect(w.sentence).toBe("Nathan is rebasing onto develop");
        expect(w.why).toBe("");
        expect(w.facts).not.toContain("conflicts with develop");
    });

    it("a sub-agent or a background agent is followed through its parent session", () => {
        const s = state({ pr: pr(), agents: [Background] });
        expect(s.kind).toBe("agent-working");
        expect(wordPhrase(s.primary.label)).toBe("Follow Salomé");
        expect(s.primary.blockId).toBe("salome");
    });

    it("Validate while an agent works asks to confirm, never blocks (#943)", () => {
        const s = state({ pr: pr(), agents: [Nathan] });
        const validate = s.menu.find((a) => a.id === "validate");
        expect(validate.disabled).toBeUndefined();
        expect(wordPhrase(validate.confirm)).toBe("Nathan is still working on this branch.");
    });

    it("a draft in an agent's board column without a visible agent: an agent is on it, calm", () => {
        const w = words({
            pr: pr({ draft: true }),
            boardTurn: { owner: "agent", kind: "agent", status: "AI Testing" },
            boardStatus: "AI Testing",
        });
        expect(w.kind).toBe("agent-working");
        expect(w.sentence).toBe("An agent is on it");
        expect(w.why).toBe("column AI Testing");
        expect(w.molten).toBe(false);
    });

    it("an agent works without a terminal here: the card asks nothing, Mark ready first in the menu (#1085)", () => {
        const input = {
            pr: pr({ draft: true }),
            boardTurn: { owner: "agent" as const, kind: "agent" as const, status: "In Progress" },
            boardStatus: "In Progress",
        };
        expect(state(input).primary).toBeNull();
        expect(words(input).menu).toEqual([
            "Mark ready for review: the PR leaves draft",
            "Assisted review",
            "Launch this version",
            "Open on GitHub",
        ]);
        const commit = state({ pr: pr({ draft: true }), boardTurn: { owner: "agent", kind: "agent" } });
        expect(commit.primary).toBeNull();
        expect(commit.menu[0].id).toBe("mark-ready");
        const ready = state({ pr: pr(), boardTurn: { owner: "agent", kind: "agent" } });
        expect(ready.kind).toBe("ready");
    });

    it("an agent with a terminal to follow keeps Follow, not a task (#1085)", () => {
        expect(state({ pr: pr({ draft: true }), agents: [Nathan] }).primary.id).toBe("follow");
        expect(state({ pr: pr({ draft: true }), agents: [Nathan] }).menu[0].id).toBe("mark-ready");
    });

    it("work interrupted, session open: Relaunch {name}, molten", () => {
        const w = words(Cases[3].input);
        expect(w.sentence).toBe("Work interrupted");
        expect(w.why).toBe("Jeanne stopped before finishing the rebase");
        expect(w.primary).toBe("Relaunch Jeanne");
        expect(w.molten).toBe(true);
    });

    it("conflicts, nobody on it: Hand the rebase over; Validate is shown off with GitHub's reason", () => {
        const s = state({ pr: pr({ merge: "conflicts" }) });
        expect(wordPhrase(s.primary.label)).toBe("Hand the rebase over");
        expect(s.tone).toBe("broken");
        expect(s.turn).toBe("blocked");
        const validate = s.menu.find((a) => a.id === "validate");
        expect(wordPhrase(validate.disabled)).toBe("Conflicts with develop: ask for a rebase first.");
        expect(s.menu.some((a) => a.id === "investigate")).toBe(false);
    });

    it("CI failing: one mention of the failure, Analyze and resolve, Rerun named apart from Relaunch", () => {
        const input = {
            pr: pr({ merge: "failing" }, [Failed(), ...Green.slice(1)]),
            rerunnable: true,
            task: Fix,
            taskState: "stuck" as const,
            taskLive: false,
            headFails: ["Backend"],
        };
        const w = words(input);
        expect(w.kind).toBe("failing");
        expect(w.sentence).toBe("CI failing: Backend");
        expect(w.why).toBe("on the latest commit");
        expect(w.primary).toBe("Analyze and resolve");
        expect(w.facts).toEqual(["3 other checks green", "report"]);
        expect(w.history).toBe("Salomé stopped before finishing the resolution of what blocks it.");
        expect(w.menu).toEqual([
            "Rerun failed jobs: Backend",
            "Start an agent",
            "Validate",
            "Assisted review",
            "Open on GitHub",
        ]);
    });

    it("changes requested is agent-fixable: Analyze and resolve", () => {
        const w = words({ pr: pr({ reviewdecision: "CHANGES_REQUESTED", merge: "blocked" }) });
        expect(w.kind).toBe("failing");
        expect(w.sentence).toBe("Changes requested");
        expect(w.primary).toBe("Analyze and resolve");
    });

    it("review required is amber and the developer's: Assisted review, no Analyze and resolve", () => {
        const s = state({ pr: pr({ merge: "blocked", reviewdecision: "REVIEW_REQUIRED" }) });
        expect(wordPhrase(s.sentence)).toBe("Review required");
        expect(wordPhrase(s.why)).toBe("GitHub awaits an approval");
        expect(s.tone).toBe("you");
        expect(s.primary.id).toBe("assisted-review");
        expect(s.molten).toBe(true);
        expect(s.menu.map((a) => a.id)).toEqual(["validate", "launch", "github"]);
        expect(s.menu[0].disabled).toBeTruthy();
    });

    // #1212: in a workflow without Human Testing a draft is its agent's even with its agent idle, its quick checks
    // green or its CI red: Resume {name}, calm, in Agents on it; the developer can still take it over from the menu.
    it("a draft its agent stopped before marking ready: Resume {name}, never the developer's", () => {
        const w = words({ pr: pr({ draft: true }), agents: [Jeanne], agentReadies: true });
        expect(w.kind).toBe("agent-finish");
        expect(w.sentence).toBe("The agent still has to mark it ready");
        expect(w.why).toBe("your workflow has no Human Testing: the agent marks its draft ready itself");
        expect(w.primary).toBe("Resume Jeanne");
        expect(w.molten).toBe(false);
        expect(w.menu[0]).toBe("Mark ready for review: the PR leaves draft");
        const s = state({ pr: pr({ draft: true }), agents: [Jeanne], agentReadies: true });
        expect([s.turn, s.works, s.motion]).toEqual(["agents", false, null]);
        const red = words({ pr: pr({ draft: true }, [Failed()]), agentReadies: true });
        expect([red.kind, red.why, red.primary]).toEqual(["agent-finish", "CI failing: Backend", "Resume an agent"]);
        const conflicts = words({ pr: pr({ draft: true, merge: "conflicts" }), agentReadies: true });
        expect([conflicts.kind, conflicts.why]).toEqual(["agent-finish", "conflicts with develop"]);
        const workflowOnly = state({
            pr: pr({ draft: true }),
            agentReadies: true,
            boardTurn: { owner: "agent", kind: "agent", workflow: true },
        });
        expect(workflowOnly.kind).toBe("agent-finish");
        expect(state({ pr: pr({ draft: true }), agents: [Nathan], agentReadies: true }).kind).toBe("agent-working");
        expect(state({ pr: pr({ draft: true }), agents: [Diane], agentReadies: true }).kind).toBe("agent-waiting");
    });

    it("no draft reads Ready, whatever its quick checks say (#1212)", () => {
        const quick: ReviewCheck[] = [...Green, { name: "Build", state: "neutral" }];
        for (const agentReadies of [false, true]) {
            const s = words({ pr: pr({ draft: true }, quick), agentReadies });
            expect(s.sentence).not.toMatch(/ready for review|ready to merge/i);
            expect(s.kind).not.toBe("ready");
        }
        expect(words({ pr: pr() }).sentence).toBe("Ready to merge");
    });

    it("a draft to test: Mark ready, its confirmation names the missing report", () => {
        const s = state({ pr: pr({ draft: true, report: { state: "missing" } }) });
        expect(wordPhrase(s.sentence)).toBe("Draft to test");
        expect(s.primary.id).toBe("mark-ready");
        expect(wordPhrase(s.primary.confirm)).toBe("No test report yet.");
        expect(s.facts.find((f) => f.id === "report").tone).toBe("soft");
    });

    it("CI running: calm Assisted review, Validate still in the menu, behind is a fact", () => {
        const w = words(Cases[8].input);
        expect(w.sentence).toBe("CI running");
        expect(w.why).toBe("2 of 4, Backend, Build");
        expect(w.primary).toBe("Assisted review");
        expect(w.molten).toBe(false);
        expect(w.menu).toEqual(["Validate", "Launch this version", "Open on GitHub"]);
        expect(w.facts).toContain("behind develop, GitHub will update it");
    });

    it("ready to merge: Validate, molten, green facts", () => {
        const w = words({ pr: pr() });
        expect(w.sentence).toBe("Ready to merge");
        expect(w.primary).toBe("Validate");
        expect(w.molten).toBe(true);
        expect(w.facts).toEqual(["CI 4/4", "report"]);
        expect(w.menu).toEqual(["Assisted review", "Launch this version", "Open on GitHub"]);
    });
});

describe("cardState: precedence (#1060)", () => {
    it("a waiting agent wins over a working one, conflicts and a failure", () => {
        const s = state({ pr: pr({ merge: "conflicts" }, [Failed()]), agents: [Nathan, Diane] });
        expect(s.kind).toBe("agent-waiting");
    });

    it("a working agent wins over a stuck task, conflicts and a failure", () => {
        const s = state({
            pr: pr({ merge: "conflicts" }, [Failed()]),
            agents: [Nathan, Jeanne],
            task: Rebase,
            taskState: "stuck",
            taskOwner: Jeanne,
            taskLive: true,
        });
        expect(s.kind).toBe("agent-working");
    });

    it("an open stopped task wins over conflicts; a gone one leaves them the state, with a history line", () => {
        const pr1 = pr({ merge: "conflicts" });
        expect(state({ pr: pr1, task: Rebase, taskState: "stuck", taskLive: true, taskOwner: Jeanne }).kind).toBe(
            "interrupted"
        );
        const gone = state({ pr: pr1, task: Rebase, taskState: "stuck", taskLive: false });
        expect(gone.kind).toBe("conflicts");
        expect(gone.history).toBeTruthy();
    });

    it("a gone stopped task with nothing else left reads interrupted: Start an agent", () => {
        const s = state({ pr: pr(), task: Rebase, taskState: "stuck", taskLive: false });
        expect(s.kind).toBe("interrupted");
        expect(s.primary.id).toBe("start-agent");
    });

    it("conflicts win over a failure", () => {
        expect(state({ pr: pr({ merge: "conflicts" }, [Failed()]) }).kind).toBe("conflicts");
    });

    it("a failure wins over a required review", () => {
        expect(state({ pr: pr({ merge: "blocked", reviewdecision: "REVIEW_REQUIRED" }, [Failed()]) }).kind).toBe(
            "failing"
        );
    });

    it("a block with only running checks reads CI running, not a rule", () => {
        const s = state({ pr: pr({ merge: "blocked" }, [{ name: "Backend", state: "pending" }]) });
        expect(s.kind).toBe("ci-running");
    });

    it("running checks win over a draft's Mark ready and a ready PR's Validate", () => {
        const running: ReviewCheck[] = [{ name: "Backend", state: "pending" }];
        expect(state({ pr: pr({ draft: true }, running) }).kind).toBe("ci-running");
        expect(state({ pr: pr({}, running) }).kind).toBe("ci-running");
    });

    it("GitHub still computing the merge reads as waiting", () => {
        const s = state({ pr: pr({ merge: "unknown" }) });
        expect(s.kind).toBe("ci-running");
        expect(wordPhrase(s.sentence)).toBe("GitHub is checking the merge");
    });
});

describe("Analyze and resolve only for what an agent can fix (#1060, FR-REV-028 AC12)", () => {
    const offers = (p: ReviewPr) => {
        const s = state({ pr: p });
        return s.primary.id === "investigate" || s.menu.some((a) => a.id === "investigate");
    };

    it("not for a branch only behind its base, a missing report alone or a required review", () => {
        expect(offers(pr({ merge: "behind" }))).toBe(false);
        expect(offers(pr({ report: { state: "missing" } }))).toBe(false);
        expect(offers(pr({ merge: "blocked", reviewdecision: "REVIEW_REQUIRED" }))).toBe(false);
    });

    it("not beside the rebase on conflicts", () => {
        expect(offers(pr({ merge: "conflicts" }))).toBe(false);
    });

    it("for failed checks, local ones included, and requested changes", () => {
        expect(offers(pr({}, [{ name: "local-e2e", state: "failure", local: true }]))).toBe(true);
        expect(offers(pr({ reviewdecision: "CHANGES_REQUESTED" }))).toBe(true);
    });
});

describe("one orange button per card, only on the developer's turn", () => {
    it("molten only for the developer's moves", () => {
        const molten = Cases.filter((c) => state(c.input).molten).map((c) => c.kind);
        expect(molten).toEqual([
            "agent-waiting",
            "interrupted",
            "conflicts",
            "failing",
            "review-required",
            "draft-ready",
            "ready",
        ]);
    });
});

describe("the dominoes mean work in progress (#1085, FR-REV-022 AC13)", () => {
    const Running: ReviewCheck[] = [
        ...Green.slice(0, 3),
        ...Array.from({ length: 10 }, (_, i): ReviewCheck => ({ name: `Job ${i}`, state: "pending" })),
    ];
    const InProgress = { boardTurn: { owner: "agent" as const, kind: "agent" as const, status: "In Progress" } };

    it("an agent inferred from the board column: the state line shows them", () => {
        const s = state({ pr: pr({ draft: true }, Running), ...InProgress, boardStatus: "In Progress" });
        expect(s.kind).toBe("agent-working");
        expect([s.works, s.motion]).toEqual([true, "state"]);
    });

    it("an agent inferred from a recent commit: the state line shows them", () => {
        const s = state({ pr: pr({ draft: true }), boardTurn: { owner: "agent", kind: "agent" } });
        expect([s.kind, s.motion]).toEqual(["agent-working", "state"]);
    });

    it("a live working agent or a background agent: their line shows them, the state keeps its dot", () => {
        expect(state({ pr: pr(), agents: [Nathan] }).motion).toBe("agent");
        expect(state({ pr: pr(), agents: [Background] }).motion).toBe("agent");
        expect(state({ pr: pr(), agents: [Background] }).works).toBe(true);
    });

    it("CI running with nothing asked: the state line shows them", () => {
        const s = state(Cases[8].input);
        expect([s.kind, s.works, s.motion]).toEqual(["ci-running", true, "state"]);
        expect(state({ ...Cases[8].input, agents: [Jeanne] }).motion).toBe("state");
    });

    it("nothing works: no dominoes", () => {
        for (const kind of [
            "agent-waiting",
            "interrupted",
            "conflicts",
            "failing",
            "review-required",
            "draft-ready",
            "ready",
        ]) {
            const s = state(Cases.find((c) => c.kind === kind).input);
            expect([kind, s.works, s.motion]).toEqual([kind, false, null]);
        }
    });

    it("never two animations on one card", () => {
        const inputs: (Partial<CardInput> & { pr: ReviewPr })[] = [
            ...Cases.map((c) => c.input),
            { pr: pr({ draft: true }, Running), agents: [Nathan], ...InProgress },
            { pr: pr({}, Running), agents: [Nathan, Background] },
            { pr: pr({ draft: true }, Running), ...InProgress },
        ];
        for (const input of inputs) {
            const s = state(input);
            const barMoves = (input.agents ?? []).some((a) => a.state === "working" || a.state === "background");
            expect(barMoves && s.motion === "state").toBe(false);
        }
    });

    it("a stopped task's line does not animate: the state line may", () => {
        const s = state({
            pr: pr({}, Running),
            agents: [Background],
            task: Fix,
            taskState: "stuck",
            taskOwner: Background,
            taskLive: true,
        });
        expect([s.kind, s.motion]).toEqual(["agent-working", "state"]);
    });

    it("the CI fact while checks run reads running, never the check mark", () => {
        const s = state({ pr: pr({ draft: true }, Running), ...InProgress });
        const ci = s.facts.find((f) => f.id === "ci");
        expect(wordPhrase(ci.text)).toBe("CI 3/13, 10 running");
        expect(ci.tone).toBe("running");
    });

    it("the CI fact once every check passed: the check mark", () => {
        const ci = state({ pr: pr() }).facts.find((f) => f.id === "ci");
        expect([wordPhrase(ci.text), ci.tone]).toEqual(["CI 4/4", "ok"]);
    });

    it("skipped checks are done but not green: named, no check mark", () => {
        const skipped: ReviewCheck[] = [
            ...Green.slice(0, 3),
            ...Array.from({ length: 10 }, (_, i): ReviewCheck => ({ name: `Job ${i}`, state: "neutral" })),
        ];
        const ci = state({ pr: pr({}, skipped) }).facts.find((f) => f.id === "ci");
        expect([wordPhrase(ci.text), ci.tone]).toEqual(["CI 3/13, 10 skipped", "muted"]);
    });
});

describe("the other branches of the PR's ticket (#1172)", () => {
    it("lists them on the card, never as upcoming", () => {
        expect(words({ pr: pr(), others: [{ branch: "test/1101-local" }] }).facts).toContain(
            "also on this ticket: the branch test/1101-local"
        );
        expect(words({ pr: pr(), others: [{ branch: "test/1101-a" }, { branch: "test/1101-b" }] }).facts).toContain(
            "also on this ticket: the branches test/1101-a, test/1101-b"
        );
        expect(words({ pr: pr(), others: [] }).facts.some((f) => f.startsWith("also on"))).toBe(false);
    });

    it("says a draft is the agents' by the workflow, not by a commit, when nothing else says so", () => {
        const w = words({ pr: pr({ draft: true }), boardTurn: { owner: "agent", kind: "agent", workflow: true } });
        expect(w.kind).toBe("agent-working");
        expect(w.why).toBe("your workflow leaves drafts to the agents until review");
    });
});

describe("in French", () => {
    beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("names the ticket's other branches (#1172)", () => {
        expect(words({ pr: pr(), others: [{ branch: "test/1101-local" }] }).facts).toContain(
            "aussi sur ce ticket : la branche test/1101-local"
        );
    });

    it("words the states as the mockup does", () => {
        expect(words({ pr: pr({ merge: "conflicts", draft: true }), agents: [Nathan] }).sentence).toBe(
            "Nathan s'en occupe"
        );
        expect(words({ pr: pr({ draft: true }) }).primary).toBe("Passer en revue");
        expect(words({ pr: pr() }).sentence).toBe("Prête à fusionner");
        expect(words({ pr: pr({ merge: "conflicts" }) }).primary).toBe("Confier le rebase");
        expect(words(Cases[5].input).sentence).toBe("CI en échec : Backend");
        expect(
            words({ pr: pr({ draft: true }, [...Green, { name: "E2E", state: "pending" }]), agents: [Nathan] }).facts
        ).toContain("CI 4/5, 1 en cours");
        expect(words({ pr: pr({}, [...Green, { name: "E2E", state: "neutral" }]) }).facts).toContain(
            "CI 4/5, ignorées : 1"
        );
    });
});
