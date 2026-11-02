// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentFacts, OnboardingAgent, OnboardingAgents } from "../../moltenterm-onboarding/onboarding-agent-model";
import {
    agentStatusKind,
    chooseAgents,
    configHoldsKey,
    installStatus,
    isStale,
    libraryAgents,
    manualUninstallCommands,
    matrixSummary,
    priceLine,
    uninstallOffer,
    uninstallPhase,
    uninstallRemoves,
    uninstallStatus,
} from "./agents-model";

function agent(id: string, name: string, extra: Partial<OnboardingAgent> = {}): OnboardingAgent {
    return {
        id,
        name,
        path: "",
        invocation: "/{name} <request>",
        format: "skill",
        installed: false,
        guides: [],
        found: false,
        executable: id,
        ...extra,
    };
}

function facts(extra: Partial<AgentFacts>): AgentFacts {
    return { checkedon: "2026-11-01", freetier: "no", uses: ["code"], ...extra };
}

const List: OnboardingAgents = {
    version: "1",
    agents: [
        agent("claude-code", "Claude Code", {
            found: true,
            signedin: true,
            profile: facts({ from: { amount: "20", currency: "USD", plan: "Pro" }, includedin: ["claude"] }),
        }),
        agent("codex", "Codex", {
            profile: facts({
                freetier: "yes",
                from: { amount: "8", currency: "USD", plan: "Go" },
                includedin: ["chatgpt"],
            }),
        }),
        agent("kimi", "Kimi Code", { found: true, profile: facts({ from: { amount: "19", currency: "USD" } }) }),
        agent("grok", "Grok Build", {
            profile: facts({ freetier: "notstated", from: { currency: "USD" }, includedin: ["x-subscription"] }),
        }),
        agent("cursor", "Cursor CLI", {
            profile: facts({
                freetier: "notstated",
                from: { amount: "8", currency: "USD" },
                includedin: ["x-subscription"],
            }),
        }),
        agent("gemini-cli", "Gemini CLI"),
        agent("generic", "Any other agent", { executable: "" }),
    ],
};

describe("library agents", () => {
    it("lists the found agents first, then the others, each by name, without recipes or Gemini CLI unfound", () => {
        const ids = libraryAgents(List).map((r) => r.card.id);
        expect(ids).toEqual(["claude-code", "kimi", "codex", "cursor", "grok"]);
    });

    it("never says a sign-in it did not see is missing", () => {
        const rows = libraryAgents(List);
        expect(agentStatusKind(rows[0].card)).toBe("signedin");
        expect(agentStatusKind(rows[1].card)).toBe("signinunseen");
        expect(agentStatusKind(rows[2].card)).toBe("missing");
    });

    it("offers the uninstall button only for a documented, matched method", () => {
        expect(uninstallOffer(agent("x", "X"))).toBe("none");
        expect(uninstallOffer(agent("x", "X", { found: true }))).toBe("manual");
        expect(
            uninstallOffer(
                agent("x", "X", { found: true, uninstall: { method: "npm", command: "npm uninstall -g x" } })
            )
        ).toBe("manual");
        expect(
            uninstallOffer(
                agent("x", "X", { found: true, uninstall: { method: "npm", command: "npm un -g x", available: true } })
            )
        ).toBe("button");
    });

    it("lists the manual commands once, the undocumented ones marked by the caller", () => {
        const a = agent("codex", "Codex", {
            uninstallmethods: [
                { method: "npm", command: "npm uninstall -g @openai/codex" },
                { method: "native" },
                { method: "npm", command: "npm uninstall -g @openai/codex" },
            ],
        });
        expect(manualUninstallCommands(a).map((m) => m.command)).toEqual(["npm uninstall -g @openai/codex"]);
    });

    it("names the settings folders only when ticked", () => {
        const u = { method: "native", command: "rm", removes: ["~/.local/bin/claude"], config: ["~/.claude"] };
        expect(uninstallRemoves(u, false)).toEqual({ files: ["~/.local/bin/claude"], trash: [] });
        expect(uninstallRemoves(u, true)).toEqual({ files: ["~/.local/bin/claude"], trash: ["~/.claude"] });
        expect(configHoldsKey(u)).toBe("library.agents.uninstall.holds.other");
        expect(configHoldsKey({ ...u, configholdskey: "library.agents.uninstall.holds.claude-code" })).toBe(
            "library.agents.uninstall.holds.claude-code"
        );
    });

    it("tells an uninstall from an install, and a copy still there after the command", () => {
        const job = { id: "kimi", kind: "uninstall" as const, state: "succeeded" as const };
        expect(installStatus(job)).toBeNull();
        expect(uninstallStatus(job)).toBe(job);
        expect(uninstallPhase(job, true)).toBe("stillfound");
        expect(uninstallPhase(job, false)).toBe("done");
        expect(installStatus({ id: "kimi", state: "running" })).not.toBeNull();
    });

    it("prints the price as the vendor shows it, or says it is not stated", () => {
        expect(
            priceLine(facts({ freetier: "yes", from: { amount: "19.99", currency: "USD", plan: "Google AI Pro" } }))
        ).toEqual({
            key: "freeThen",
            vars: { amount: "19.99", currency: "USD", period: "month", plan: "Google AI Pro" },
            noteKey: undefined,
        });
        expect(priceLine(facts({ freetier: "notstated", from: { currency: "USD" } }))).toEqual({
            key: "notstated",
            freeUnknown: true,
        });
        expect(priceLine(facts({ from: { amount: "20", currency: "USD" } })).key).toBe("fromBare");
        expect(priceLine(null)).toBeNull();
    });

    it("says the facts may have changed after 90 days", () => {
        expect(isStale("2026-11-01", new Date("2027-01-15"))).toBe(false);
        expect(isStale("2026-11-01", new Date("2027-02-15"))).toBe(true);
        expect(isStale("", new Date())).toBe(false);
    });

    it("counts the matrix row of the agent, nothing when the matrix does not know it", () => {
        const matrix = {
            asof: "2026-11-01",
            features: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
            agents: [
                {
                    id: "kimi",
                    features: { a: { level: "native" }, b: { level: "adapted" }, c: { level: "process-only" } },
                },
            ],
        };
        expect(matrixSummary(matrix, "kimi")).toEqual({
            native: 1,
            adapted: 1,
            limited: 1,
            total: 4,
            asof: "2026-11-01",
        });
        expect(matrixSummary(matrix, "codex")).toBeNull();
        expect(matrixSummary(null, "kimi")).toBeNull();
    });
});

describe("help me choose", () => {
    const rows = libraryAgents(List);

    it("puts a subscription already paid first, whatever the budget", () => {
        const result = chooseAgents(rows, { goal: "code", budget: "free", already: "claude" }, 1);
        expect(result.shown[0].row.card.id).toBe("claude-code");
        expect(result.shown[0].reasons[0].key).toBe("library.agents.choose.reasons.already-paid");
        expect(result.shown[0].reasons[0].vars).toEqual({ plan: "Claude" });
    });

    it("keeps only the free agents for Nothing for now, and an unstated price passes no budget", () => {
        const result = chooseAgents(rows, { goal: "code", budget: "free", already: "none" }, 7);
        expect([...result.shown, ...result.others].map((s) => s.row.card.id)).toEqual(["codex"]);
        const around = chooseAgents(rows, { budget: "around-20" }, 7);
        const ids = [...around.shown, ...around.others].map((s) => s.row.card.id).sort();
        expect(ids).toEqual(["claude-code", "codex", "cursor", "kimi"]);
    });

    it("shows two, the others behind a link, in a seeded random order", () => {
        const a = chooseAgents(rows, { budget: "more" }, 3);
        const b = chooseAgents(rows, { budget: "more" }, 3);
        expect(a.shown.length).toBe(2);
        expect(a.others.length).toBe(3);
        expect(a.shown.map((s) => s.row.card.id)).toEqual(b.shown.map((s) => s.row.card.id));
        const orders = new Set(
            [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
                chooseAgents(rows, { budget: "more" }, seed)
                    .shown.map((s) => s.row.card.id)
                    .join()
            )
        );
        expect(orders.size).toBeGreaterThan(1);
    });

    it("suggests both agents of a shared subscription", () => {
        const result = chooseAgents(rows, { goal: "code", budget: "around-20", already: "x-subscription" }, 5);
        expect(result.shown.map((s) => s.row.card.id).sort()).toEqual(["cursor", "grok"]);
    });

    it("finds nothing when nothing matches", () => {
        const result = chooseAgents(rows, { goal: "write-research", budget: "free" }, 1);
        expect(result.shown).toEqual([]);
    });
});
