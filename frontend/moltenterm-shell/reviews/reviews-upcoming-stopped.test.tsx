// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2270, FR-REV-022 AC23: an Upcoming ticket whose delegated agent stopped without a pull request says so and offers
// Resume. Synthetic agent states and tickets only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { setTestMatrix } from "../agent-info/agent-features-fixture";
import { t } from "../i18n/i18n";
import { wordPhrase } from "../i18n/phrase";
import type { ReviewsAnswer } from "./reviews-model";
import { UpcomingSection, upcomingState } from "./reviews-upcoming";
import {
    branchAgent,
    stoppedWithoutPr,
    upcomingResumeOutcome,
    type BranchAgent,
    type UpcomingAnswer,
    type UpcomingBranch,
} from "./reviews-upcoming-model";

const answers = vi.hoisted(() => ({ current: null as UpcomingAnswer }));

// The settings, as the app's global atoms give them once initialised.
vi.mock("@/app/store/global", async (importOriginal) => {
    const { atom } = await import("jotai");
    const fullConfigAtom = atom(null);
    const settingsAtom = atom((get) => (get(fullConfigAtom) as any)?.settings ?? {});
    return {
        ...(await importOriginal<object>()),
        atoms: { fullConfigAtom, settingsAtom },
        getSettingsKeyAtom: (key: string) => atom((get) => (get(settingsAtom) as any)[key]),
    };
});

vi.mock("./reviews-upcoming-client", () => ({
    useUpcomingWatch: () => {},
    useUpcomingAnswer: () => answers.current,
}));

setTestMatrix();

const Branch: UpcomingBranch = {
    branch: "fix/42-sample",
    ticket: 42,
    ahead: 3,
    title: "Sample ticket",
    status: "In progress",
    worktree: "/w/agent-42",
};

function sub(state: BranchAgent["state"], branch = Branch.branch): BranchAgent {
    return {
        branch,
        worktree: "/w/agent-42",
        kind: "subagent",
        agent: "claude",
        parentblockid: "lead",
        parentfirstname: "Flore",
        state,
        description: "#42 sample",
        activeat: 1,
        agentid: "abc123",
    };
}

function upcoming(agents: BranchAgent[], branches: UpcomingBranch[] = [Branch]): UpcomingAnswer {
    return { dir: "/p", target: "develop", branches, agents, at: 1 };
}

const NoPrs = { ready: [], drafts: [] } as unknown as ReviewsAnswer;

function render(agents: BranchAgent[], branches?: UpcomingBranch[], reviews = NoPrs): string {
    answers.current = upcoming(agents, branches);
    return renderToStaticMarkup(<UpcomingSection dir="/p" reviews={reviews} />);
}

describe("an Upcoming ticket whose sub-agent stopped (#2270)", () => {
    it("reads stopped without a pull request, never its board column", () => {
        for (const state of ["done", "quiet"] as const) {
            const agent = branchAgent(upcoming([sub(state)]), null, Branch.branch);
            expect(stoppedWithoutPr(agent)).toBe(true);
            const s = upcomingState(t, Branch, agent);
            expect(s.sentence).toBe("Stopped without a pull request");
            expect(s.why).toBe("3 commits ahead");
            expect(s.saysStatus).toBe(true);
            const html = render([sub(state)]);
            expect(html).toContain("Stopped without a pull request");
            expect(html).toContain("3 commits ahead");
            expect(html).not.toContain("In progress");
            expect(html).toMatch(/data-testid="reviews-upcoming-primary"[^>]*>Resume</);
        }
    });

    it("leaves a working sub-agent's card as it was", () => {
        const agent = branchAgent(upcoming([sub("running")]), null, Branch.branch);
        expect(stoppedWithoutPr(agent)).toBe(false);
        expect(upcomingState(t, Branch, agent).sentence).toBe("A sub-agent of Flore is on it");
        const html = render([sub("running")]);
        expect(html).not.toContain("Stopped without a pull request");
        expect(html).not.toMatch(/>Resume</);
        expect(html).toContain("In progress");
    });

    // #2294: wavesrv lists the sub-agents placed in a worktree before the unplaced ones, and the card read the first.
    it("never says stopped while another sub-agent of the ticket works, whichever order wavesrv lists them in", () => {
        const placedStopped = (state: BranchAgent["state"]) => sub(state);
        const unplacedRunning: BranchAgent = { ...sub("running", ""), worktree: "", agentid: "def456" };
        for (const state of ["done", "quiet"] as const) {
            for (const list of [
                [placedStopped(state), unplacedRunning],
                [unplacedRunning, placedStopped(state)],
            ]) {
                const agent = branchAgent(upcoming(list), null, Branch.branch);
                expect(agent.subState, state).toBe("running");
                expect(stoppedWithoutPr(agent), state).toBe(false);
                const html = render(list);
                expect(html, state).not.toContain("Stopped without a pull request");
                expect(html, state).not.toMatch(/>Resume</);
                expect(html, state).toContain("A sub-agent of Flore is on it");
            }
        }
    });

    it("keeps a panel agent ahead of any sub-agent, and a finished sub-agent ahead of a background guess", () => {
        const panel: BranchAgent = { branch: Branch.branch, worktree: "/w/agent-42", kind: "panel", blockid: "p1" };
        const background: BranchAgent = {
            branch: Branch.branch,
            worktree: "/w/agent-42",
            kind: "background",
            activeat: 1,
        };
        const states = {
            states: { p1: { blockid: "p1", agent: "claude", state: "idle", version: 1 } },
            versions: {},
        } as any;
        const first = (list: BranchAgent[]) => branchAgent(upcoming(list), states, Branch.branch);
        expect(first([sub("running"), panel]).kind).toBe("panel");
        expect(first([background, sub("done")]).kind).toBe("subagent");
    });

    it("shows no card once the pull request exists", () => {
        const withPr = {
            ready: [],
            drafts: [{ branch: Branch.branch, number: 7, ticket: 42 }],
        } as unknown as ReviewsAnswer;
        const html = render([sub("done")], undefined, withPr);
        expect(html).not.toContain("Stopped without a pull request");
    });

    it("says it on the session card's line when the session holds several tickets", () => {
        const other: UpcomingBranch = { ...Branch, branch: "fix/43-other", ticket: 43, ahead: 1 };
        const html = render([sub("done"), sub("done", other.branch)], [Branch, other]);
        expect(html).toContain("2 tickets stopped without a pull request");
        expect(html).toContain("stopped without a pull request");
        expect(html).not.toContain("In progress");
    });
});

describe("Resume's answer (#2270)", () => {
    const say = (result: Parameters<typeof upcomingResumeOutcome>[0]) => wordPhrase(upcomingResumeOutcome(result));

    it("words each answer", () => {
        expect(say({ status: "sent", firstname: "Flore" })).toContain("Handed to Flore");
        expect(say({ status: "queued", firstname: "Flore" })).toContain("Flore is busy");
        expect(say({ status: "busy", reason: "alreadyhanded", firstname: "Flore" })).toBe(
            "Flore already has this request: nothing more was sent."
        );
        expect(say({ status: "busy", reason: "subagentbusy", firstname: "Flore" })).toContain("working on it again");
        expect(say({ status: "failed", reason: "leadnotrunning", firstname: "Flore" })).toBe(
            "Flore no longer runs: nothing was sent."
        );
        expect(say({ status: "failed", reason: "nothingtoresume" })).toContain("No sub-agent can be continued");
        expect(say({ status: "failed", message: "boom" })).toBe("Resume did not go through: boom");
    });
});
