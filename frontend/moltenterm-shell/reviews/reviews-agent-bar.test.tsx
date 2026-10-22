// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { getDefaultStore } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentBar, MinuteClock } from "./reviews-agent-bar";
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
