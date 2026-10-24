// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { getDefaultStore } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStates } from "../agent-state-store";
import { AgentBar, MinuteClock, RowAgentLine } from "./reviews-agent-bar";
import type { ReviewPr } from "./reviews-model";
import { UpcomingAnswers } from "./reviews-upcoming-client";
import { AgentBarFacts } from "./reviews-upcoming-model";

const Now = new Date(2026, 9, 16, 12, 0).getTime();
const Started = Now - 12.5 * 60_000;
const Clock = MinuteClock.getInstance().nowAtom;
const PreviousNow = getDefaultStore().get(Clock);

beforeEach(() => getDefaultStore().set(Clock, Now));
afterEach(() => getDefaultStore().set(Clock, PreviousNow));

describe("AgentBar (#712 AC2, AC4)", () => {
    it("draws nothing without an agent", () => {
        expect(renderToStaticMarkup(<AgentBar facts={null} />)).toBe("");
    });

    it("shows a panel agent's name, state, time and Go to, the working rail on the shared beat", () => {
        const facts: AgentBarFacts = {
            kind: "panel",
            blockId: "b1",
            agent: "claude",
            name: "Valentin",
            state: "working",
            since: Started,
        };
        const html = renderToStaticMarkup(<AgentBar facts={facts} />);
        expect(html).toContain('data-state="working"');
        expect(html).toMatch(/data-testid="reviews-agent-name"[^>]*>Valentin</);
        expect(html).toMatch(/data-testid="reviews-agent-state"[^>]*>working</);
        expect(html).toMatch(/for 12 min · since \d\d:\d\d/);
        expect(html).toContain('data-testid="reviews-agent-goto"');
        expect(html).toMatch(/cursor-pointer/);
        expect(html).toMatch(/mt-beat-blink/);
        expect(html).not.toMatch(/animate-/);
        expect(html).toMatch(/class="df-domino-loader text-\[var\(--mt-state-working\)\]" aria-hidden="true"/);
    });

    it("lays the state rail on the tile's border, and draws none for idle or background (#738)", () => {
        const working = renderToStaticMarkup(
            <AgentBar
                facts={{
                    kind: "panel",
                    blockId: "b1",
                    agent: "claude",
                    name: "Valentin",
                    state: "working",
                    since: Started,
                }}
            />
        );
        expect(working).toMatch(/class="absolute inset-y-0 -left-px w-0\.5[^"]*"[^>]*data-testid="reviews-agent-rail"/);
        for (const facts of [
            { kind: "panel", blockId: "b1", agent: "claude", name: "Valentin", state: "idle", since: Started },
            { kind: "background", agent: "claude", name: "", state: "background", since: Started },
        ] as AgentBarFacts[]) {
            const html = renderToStaticMarkup(<AgentBar facts={facts} />);
            expect(html).toContain('data-testid="reviews-agent-bar"');
            expect(html).not.toContain("reviews-agent-rail");
        }
    });

    it("puts waiting in the waiting colour, with nothing moving", () => {
        const facts: AgentBarFacts = {
            kind: "panel",
            blockId: "b1",
            agent: "codex",
            name: "Jérôme",
            state: "waiting",
            since: Started,
        };
        const html = renderToStaticMarkup(<AgentBar facts={facts} />);
        expect(html).toMatch(/text-\[var\(--mt-state-waiting\)\][^>]*>waiting for you</);
        expect(html).not.toMatch(/mt-beat-blink/);
        expect(html).not.toContain("df-domino-loader");
    });

    it("says a background agent is probably active, without Go to, with its parent session", () => {
        const facts: AgentBarFacts = {
            kind: "background",
            agent: "claude",
            name: "",
            state: "background",
            since: Now - 3.5 * 60_000,
            parentBlockId: "b9",
            parentName: "Valentin",
        };
        const html = renderToStaticMarkup(<AgentBar facts={facts} />);
        expect(html).toContain("Background agent");
        expect(html).toContain("probably active");
        expect(html).toContain('class="df-domino-loader text-secondary" aria-hidden="true"');
        expect(html).toContain("last change 3 min ago");
        expect(html).not.toContain('data-testid="reviews-agent-goto"');
        expect(html).toMatch(/data-testid="reviews-agent-parent"[\s\S]*Valentin&#x27;s session/);
    });

    it("names a sub-agent by its parent, tool, model and task, Go to showing the parent (#1035)", () => {
        const facts: AgentBarFacts = {
            kind: "subagent",
            agent: "claude",
            name: "",
            state: "working",
            subState: "running",
            since: Now - 2 * 60_000,
            parentBlockId: "b9",
            parentName: "Valentin",
            model: "claude-opus-5-5",
            description: "#1033 agent name in tabs",
        };
        const html = renderToStaticMarkup(<AgentBar facts={facts} />);
        expect(html).toContain("Sub-agent of Valentin");
        expect(html).toContain("Claude Code · Opus 5.5 · #1033 agent name in tabs");
        expect(html).toMatch(/data-testid="reviews-agent-state"[^>]*>working</);
        expect(html).not.toContain("probably active");
        expect(html).toContain('data-testid="reviews-agent-goto"');
        expect(html).toContain("Show Valentin&#x27;s panel");
        expect(html).not.toContain('data-testid="reviews-agent-parent"');
    });

    it("says a sub-agent finished, and since when", () => {
        const facts: AgentBarFacts = {
            kind: "subagent",
            agent: "codex",
            name: "",
            state: "done",
            subState: "done",
            since: Now - 12 * 60_000,
            parentBlockId: "b8",
            parentName: "Jérôme",
            description: "audit reliability",
        };
        const html = renderToStaticMarkup(<AgentBar facts={facts} />);
        expect(html).toContain("Sub-agent of Jérôme");
        expect(html).toContain("Codex · audit reliability");
        expect(html).toMatch(/data-testid="reviews-agent-state"[^>]*>finished 12 min ago</);
        expect(html.replace(/aria-label="[^"]*"/, "").match(/finished/g)).toHaveLength(1);
        expect(html).not.toContain('data-testid="reviews-agent-time"');
        expect(html).not.toContain("df-domino-loader");
    });
});

describe("The PR's one who line (#954)", () => {
    const bruno: AgentBarFacts = {
        kind: "panel",
        blockId: "b1",
        agent: "claude",
        name: "Bruno",
        state: "idle",
        since: Started,
    };

    it("puts the live agent first and the other signers after it, every signature on hover", () => {
        const html = renderToStaticMarkup(
            <AgentBar
                facts={bruno}
                signers={[
                    { firstname: "Valentin", agent: "Claude Code", model: "Opus 5.5" },
                    { firstname: "Bruno", agent: "Claude Code" },
                    { firstname: "Rita", agent: "Codex" },
                ]}
            />
        );
        expect(html.indexOf("Bruno")).toBeLessThan(html.indexOf("signed Valentin +1"));
        expect(html).toMatch(/data-testid="reviews-agent-signers"/);
        expect(html).toContain("Valentin · Claude Code · Opus 5.5");
        expect(html).not.toContain("unknown");
    });

    it("adds no signers when the live agent is the only one", () => {
        const html = renderToStaticMarkup(<AgentBar facts={bruno} signers={[{ firstname: "Bruno" }]} />);
        expect(html).not.toContain("reviews-agent-signers");
    });

    it("says a stuck agent stopped before finishing, in the waiting colour, with its actions", () => {
        const html = renderToStaticMarkup(
            <AgentBar
                facts={bruno}
                task={{ state: "stuck", text: "stopped before finishing the rebase: conflicts with develop remain" }}
                actions={<button data-testid="reviews-agent-retry">Retry</button>}
            />
        );
        expect(html).toContain('data-task="stuck"');
        expect(html).toMatch(/text-\[var\(--mt-state-waiting\)\][^>]*>stopped before finishing the rebase/);
        expect(html).not.toContain(">idle<");
        expect(html).toContain('data-testid="reviews-agent-rail"');
        expect(html.indexOf("reviews-agent-retry")).toBeLessThan(html.indexOf("reviews-agent-goto"));
    });

    it("keeps a running task's agent state as the agent says it", () => {
        const html = renderToStaticMarkup(
            <AgentBar facts={{ ...bruno, state: "working" }} task={{ state: "running", text: "" }} />
        );
        expect(html).toMatch(/data-testid="reviews-agent-state"[^>]*>working</);
        expect(html).not.toContain("data-task");
    });

    it("docks a stacked bar without its own margins (#1057)", () => {
        const html = renderToStaticMarkup(<AgentBar facts={bruno} stacked />);
        expect(html).not.toContain("-mb-2.5");
        expect(renderToStaticMarkup(<AgentBar facts={bruno} />)).toContain("-mb-2.5");
    });

    it("shows a gone agent's stuck task by its name, without Go to", () => {
        const html = renderToStaticMarkup(
            <AgentBar
                facts={null}
                task={{ state: "stuck", name: "Bruno", text: "its session ended before finishing the rebase" }}
            />
        );
        expect(html).toContain('data-state="gone"');
        expect(html).toMatch(/data-testid="reviews-agent-name"[^>]*>Bruno</);
        expect(html).not.toContain("reviews-agent-goto");
    });
});

describe("a card whose branch has two agents (#1057)", () => {
    const store = getDefaultStore();
    const branch = "feature/1106-handoff";
    const answers = UpcomingAnswers.getInstance().answersAtom;
    const agentStates = AgentStates.getInstance().dataAtom;
    const previous = { answers: store.get(answers), states: store.get(agentStates) };
    const pr: ReviewPr = {
        number: 1106,
        title: "Agent handoff keeps the MCP session",
        url: "https://github.com/acme/app/pull/1106",
        branch,
        base: "develop",
        createdat: "",
        updatedat: "",
        merge: "conflicts",
        ci: { state: "success", success: 4, failure: 0, pending: 0, checks: [] },
        report: { state: "present" },
        unpublished: 0,
        headoid: "h1",
    };

    beforeEach(() => {
        store.set(answers, {
            "/p": {
                dir: "/p",
                branches: [],
                at: Now,
                agents: [
                    { branch, worktree: "/w/a", kind: "panel", blockid: "jeanne", agent: "claude", started: Started },
                    { branch, worktree: "/w/b", kind: "panel", blockid: "nathan", agent: "codex", started: Started },
                ],
            },
        });
        store.set(agentStates, {
            states: {
                jeanne: {
                    blockid: "jeanne",
                    version: 1,
                    agent: "claude",
                    firstname: "Jeanne",
                    state: "idle",
                    since: 1,
                },
                nathan: {
                    blockid: "nathan",
                    version: 1,
                    agent: "codex",
                    firstname: "Nathan",
                    state: "working",
                    since: 2,
                },
            },
            versions: { jeanne: 1, nathan: 1 },
        });
    });
    afterEach(() => {
        store.set(answers, previous.answers);
        store.set(agentStates, previous.states);
    });

    function line(task: Parameters<typeof RowAgentLine>[0]["task"]): string {
        return renderToStaticMarkup(
            <RowAgentLine
                dir="/p"
                pr={pr}
                task={task}
                onRetry={() => {}}
                onOpenWork={async () => null}
                onStop={async () => null}
            />
        );
    }

    it("shows the working agent and the idle one that took the rebase, each with its own state", () => {
        const html = line({ name: "Jeanne", blockId: "jeanne", head: "h1", at: Now - 14 * 60_000, kind: "rebase" });
        const bars = html.split('data-testid="reviews-agent-bar"').slice(1);
        expect(bars).toHaveLength(2);
        expect(bars[0]).toMatch(/data-testid="reviews-agent-name"[^>]*>Nathan</);
        expect(bars[0]).toMatch(/data-testid="reviews-agent-state"[^>]*>working</);
        expect(bars[0]).not.toContain("reviews-agent-retry");
        expect(bars[1]).toMatch(/data-testid="reviews-agent-name"[^>]*>Jeanne</);
        expect(bars[1]).toContain("stopped before finishing the rebase");
        expect(bars[1]).toContain("reviews-agent-retry");
        expect(html).not.toContain("session ended");
        expect(html.match(/-mb-2\.5/g)).toHaveLength(1);
    });

    it("lists both agents without a task", () => {
        const html = line(null);
        expect(html.split('data-testid="reviews-agent-bar"')).toHaveLength(3);
        expect(html).toContain(">Nathan<");
        expect(html).toContain(">Jeanne<");
    });
});
