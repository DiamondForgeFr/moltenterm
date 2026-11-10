// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How much each agent has been tried with MoltenTerm (FR-AGC-001, FR-AGC-004, #2167): the level comes from the
// compatibility matrix, every agent has one, the chip says it calmly, its tooltip offers the report link, the agent's
// "what works" view and Help me choose say it too without hiding an agent.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const link = vi.hoisted(() => ({ openWebLink: vi.fn(async (_url: string) => true) }));
vi.mock("../open-web-link", () => link);
const rpc = vi.hoisted(() => ({ wshRpcCall: vi.fn() }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: rpc }));

import type { OnboardingAgent, OnboardingAgents } from "../../moltenterm-onboarding/onboarding-agent-model";
import { pourAgentCards } from "../../moltenterm-onboarding/onboarding-pour-agents";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { ChoosePath, LibraryChooseLook } from "../library/agents-choose";
import { chooseAgents, ChooseQuestionCount, libraryAgents } from "../library/agents-model";
import { matrixWith, RealMatrix, setTestMatrix } from "./agent-features-fixture";
import type { AgentFeatures } from "./agent-features-model";
import { openReportProblem, TriedChip, TriedTipBody } from "./agent-tried";
import {
    agentTried,
    ReportIssueUrl,
    reportProblemUrl,
    triedLevelKey,
    TriedLevels,
    triedMeaningKey,
} from "./agent-tried-model";
import { AgentWorks } from "./agent-works";

setTestMatrix();

beforeEach(() => {
    link.openWebLink.mockClear();
});

function lookup(dict: any, key: string): string {
    return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

const Row = (over: Partial<AgentFeatures>): AgentFeatures => ({
    id: "aider",
    name: "Aider",
    adapter: false,
    features: {},
    ...over,
});

// Every agent of the matrix as the onboarding catalog lists it, found so that no card is left out, with a profile so
// that Help me choose can suggest it.
function catalog(): OnboardingAgents {
    const agents = RealMatrix.agents
        .filter((a) => a.profile)
        .map(
            (a): OnboardingAgent => ({
                id: a.profile,
                name: a.name,
                executable: a.command,
                found: true,
                path: "",
                invocation: "/morph <request>",
                format: "skill",
                installed: true,
                guides: [],
                profile: { checkedon: new Date().toISOString().slice(0, 10), uses: ["code"] },
            })
        );
    return { version: "1.0.0", agents };
}

describe("the level of each agent (FR-AGC-001, AC-1 and AC-4)", () => {
    it("reads it from the matrix: Claude Code daily use, Codex tested, every other agent little tested", () => {
        expect(agentTried(RealMatrix, "claude-code")).toEqual({ level: "daily", asof: RealMatrix.triedasof });
        expect(agentTried(RealMatrix, "claude")?.level).toBe("daily");
        expect(agentTried(RealMatrix, "codex")?.level).toBe("tested");
        const others = RealMatrix.agents.filter((a) => a.id !== "claude" && a.id !== "codex");
        expect(others.length).toBeGreaterThan(0);
        for (const row of others) {
            expect(agentTried(RealMatrix, row.id)?.level, row.id).toBe("little");
        }
        expect(RealMatrix.triedasof).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("gives every agent of the matrix a level, and none for an agent that has none", () => {
        for (const row of RealMatrix.agents) {
            expect(TriedLevels, row.id).toContain(row.tried);
            expect(agentTried(RealMatrix, row.id), row.id).not.toBeNull();
        }
        expect(agentTried(matrixWith(Row({})), "aider")).toBeNull();
        expect(agentTried(matrixWith(Row({ tried: "often" })), "aider")).toBeNull();
        expect(agentTried(RealMatrix, "nobody")).toBeNull();
        expect(agentTried(null, "claude")).toBeNull();
    });

    it("reaches every card of the first launch and the Library, recipes aside", () => {
        const cards = pourAgentCards(catalog(), RealMatrix);
        const agents = cards.filter((c) => !c.recipe);
        expect(agents.map((c) => c.id).sort()).toEqual(
            RealMatrix.agents
                .filter((a) => a.profile)
                .map((a) => a.profile)
                .sort()
        );
        for (const card of agents) {
            expect(card.tried, card.id).toBeTruthy();
        }
        expect(agents.find((c) => c.id === "claude-code")?.tried?.level).toBe("daily");
        expect(agents.find((c) => c.id === "codex")?.tried?.level).toBe("tested");
        expect(agents.filter((c) => c.tried?.level === "little").length).toBe(agents.length - 2);
        for (const recipe of cards.filter((c) => c.recipe)) {
            expect(recipe.tried).toBeUndefined();
        }
    });
});

describe("the report link (AC-2)", () => {
    it("is the repository's new-issue page with the agent's name in the title", () => {
        const url = new URL(reportProblemUrl("Claude Code"));
        expect(url.origin + url.pathname).toBe("https://github.com/DiamondForgeFr/moltenterm/issues/new");
        expect(url.searchParams.get("title")).toBe("[Claude Code] ");
        expect(new URL(reportProblemUrl("Kimi Code & co")).searchParams.get("title")).toBe("[Kimi Code & co] ");
        expect(reportProblemUrl("  ")).toBe(ReportIssueUrl);
        expect(reportProblemUrl(undefined)).toBe(ReportIssueUrl);
    });

    it("opens in the browser panel, through the interface's one way to open a web page", async () => {
        await expect(openReportProblem("Codex")).resolves.toBe(true);
        expect(link.openWebLink).toHaveBeenCalledTimes(1);
        const url = new URL(link.openWebLink.mock.calls[0][0]);
        expect(url.pathname).toBe("/DiamondForgeFr/moltenterm/issues/new");
        expect(url.searchParams.get("title")).toBe("[Codex] ");
    });
});

describe("the chip and its tooltip (AC-1, AC-2)", () => {
    it("shows the level next to the agent, closed until hovered or focused", () => {
        const html = renderToStaticMarkup(
            <TriedChip name="Kimi Code" tried={{ level: "little", asof: "2026-11-10" }} testId="chip" />
        );
        expect(html).toContain('data-level="little"');
        expect(html).toContain('data-testid="chip"');
        expect(html).toContain("Little tested");
        expect(html).toContain('aria-label="Little tested: how much Kimi Code has been tried with MoltenTerm"');
        expect(html).not.toContain('data-testid="chip-tip"');
        expect(renderToStaticMarkup(<TriedChip name="Codex" tried={{ level: "tested", asof: "" }} />)).toContain(
            "Tested"
        );
        expect(renderToStaticMarkup(<TriedChip name="Claude Code" tried={{ level: "daily", asof: "" }} />)).toContain(
            "Daily use"
        );
    });

    it("shows nothing for an agent with no level", () => {
        expect(renderToStaticMarkup(<TriedChip name="Aider" tried={null} />)).toBe("");
    });

    it("explains the level in a sentence or two, says a rough edge is possible, and offers the report link", () => {
        const html = renderToStaticMarkup(
            <TriedTipBody name="Kimi Code" tried={{ level: "little", asof: "2026-11-10" }} testId="chip" />
        );
        expect(html).toContain("MoltenTerm has not been tried much with Kimi Code yet");
        expect(html).toContain("rough edge");
        expect(html).toContain("open source");
        expect(html).toContain("Level set on 2026-11-10");
        expect(html).toMatch(
            /<a href="https:\/\/github\.com\/DiamondForgeFr\/moltenterm\/issues\/new\?title=%5BKimi%20Code%5D%20"/
        );
        expect(html).toContain(">Report a problem</a>");
        for (const level of TriedLevels) {
            const sentences = (lookup(en, triedMeaningKey(level)) as string).split(/(?<=\.)\s/);
            expect(sentences.length, level).toBeLessThanOrEqual(2);
        }
    });

    it("stays calm: no alarm colour, no warning glyph, whatever the level", () => {
        const css = readFileSync(new URL("./agent-tried.css", import.meta.url), "utf8").replace(
            /\/\*[\s\S]*?\*\//g,
            ""
        );
        expect(css).not.toMatch(/error|danger|warning|failed|blocked|crimson|amber|\bred\b|#[ef][0-9a-f]{2}0{2}\b/i);
        for (const level of TriedLevels) {
            const html = renderToStaticMarkup(<TriedChip name="Some Agent" tried={{ level, asof: "2026-11-10" }} />);
            expect(html).not.toMatch(/error|danger|warning|alert|<svg|fa-/i);
        }
    });

    it("has every word in both languages, with the same placeholders", () => {
        const keys = [
            "agentTried.line",
            "agentTried.chipLabel",
            "agentTried.asof",
            "agentTried.report",
            ...TriedLevels.flatMap((l) => [triedLevelKey(l), triedMeaningKey(l)]),
        ];
        const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
        for (const key of keys) {
            expect(lookup(en, key), key).toBeTypeOf("string");
            expect(lookup(fr, key), key).toBeTypeOf("string");
            expect(holes(lookup(fr, key)), key).toEqual(holes(lookup(en, key)));
        }
        expect([
            lookup(fr, "agentTried.level.daily"),
            lookup(fr, "agentTried.level.tested"),
            lookup(fr, "agentTried.level.little"),
        ]).toEqual(["Utilisé au quotidien", "Testé", "Peu testé"]);
    });
});

describe("the agent's what-works view (AC-3)", () => {
    it("shows the same level with its date, above the groups", () => {
        const claude = renderToStaticMarkup(<AgentWorks agent="claude-code" />);
        expect(claude).toContain('data-testid="agent-works-tried"');
        expect(claude).toContain("Tried with MoltenTerm:");
        expect(claude).toContain("Daily use");
        expect(claude).toContain(`Level set on ${RealMatrix.triedasof}`);
        expect(claude.indexOf("agent-works-tried")).toBeLessThan(claude.indexOf("MoltenTerm follows:"));
        expect(renderToStaticMarkup(<AgentWorks agent="codex" />)).toContain("Tested");
        expect(renderToStaticMarkup(<AgentWorks agent="gemini" />)).toContain("Little tested");
    });

    it("leaves the line out where the card around it already shows the chip", () => {
        expect(renderToStaticMarkup(<AgentWorks agent="claude" hideTried />)).not.toContain("Tried with MoltenTerm");
    });

    it("says nothing of a level for an agent it does not know", () => {
        const html = renderToStaticMarkup(<AgentWorks agent="aider" />);
        expect(html).toContain("MoltenTerm does not know this agent yet.");
        expect(html).not.toContain("Tried with MoltenTerm");
    });
});

describe("Help me choose (equal footing stays)", () => {
    it("mentions the level on each suggestion and hides no agent because of it", () => {
        const rows = libraryAgents(catalog());
        expect(rows.length).toBeGreaterThan(2);
        const state = { step: ChooseQuestionCount, answers: { goal: "code" as const }, seed: 5 };
        const html = renderToStaticMarkup(
            <ChoosePath
                rows={rows}
                state={state}
                look={LibraryChooseLook}
                testId="choose"
                onAnswer={() => {}}
                onBack={() => {}}
                onRestart={() => {}}
            />
        );
        const shown = [...html.matchAll(/data-testid="choose-suggestion"/g)].length;
        expect(shown).toBe(2);
        expect([...html.matchAll(/data-testid="choose-tried"/g)].length).toBe(shown);
        expect(html).toMatch(/Daily use|Tested|Little tested/);
        // The level neither filters nor orders: every agent that matches the answers is suggested or listed.
        const result = chooseAgents(rows, state.answers, state.seed);
        expect(result.shown.length + result.others.length).toBe(rows.length);
    });
});
