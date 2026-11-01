// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// FR-AGC-004 (#1685): what works with an agent, from the compatibility matrix, the same words for every agent.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ wshRpcCall: vi.fn() }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: rpc }));

import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { agentEntries } from "../palette/palette-sources";
import { matrixWith, RealMatrix, setTestMatrix } from "./agent-features-fixture";
import { AgentWorks } from "./agent-works";
import { agentWorks, DetailFeatures, pickerSummary, reasonKey, type AgentWorks as Works } from "./agent-works-model";

setTestMatrix();

function lookup(dict: any, key: string): string {
    return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

function tOf(dict: any) {
    return (key: string, vars?: Record<string, string | number>) =>
        Object.entries(vars ?? {}).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), lookup(dict, key) ?? key);
}

const glance = (w: Works) => ({
    follows: w.follows.map((i) => `${i.feature}:${i.level}`),
    uses: w.uses.map((i) => `${i.feature}:${i.level}`),
    missing: w.missing.map((i) => i.feature),
});

describe("what works with an agent (FR-AGC-004)", () => {
    it("reads the groups from the matrix, by agent id or catalog id", () => {
        expect(glance(agentWorks(RealMatrix, "claude"))).toEqual({
            follows: ["state:works", "approvals:works", "usage:works"],
            uses: ["browsermcp:works", "handoff:works", "guides:works"],
            missing: [],
        });
        expect(glance(agentWorks(RealMatrix, "claude-code"))).toEqual(glance(agentWorks(RealMatrix, "claude")));
        expect(glance(agentWorks(RealMatrix, "codex"))).toEqual(glance(agentWorks(RealMatrix, "claude")));
        expect(glance(agentWorks(RealMatrix, "gemini-cli"))).toEqual({
            follows: ["state:partly"],
            uses: ["handoff:partly", "guides:works"],
            missing: ["approvals", "usage", "browsermcp"],
        });
        expect(glance(agentWorks(RealMatrix, "kimi"))).toEqual({
            follows: [],
            uses: ["guides:works"],
            missing: ["state", "approvals", "usage", "browsermcp", "handoff"],
        });
        expect(agentWorks(RealMatrix, "qwen-code").known).toBe(false);
    });

    it("treats every agent alike: the same features, in the same order, with a reason for each that does not work", () => {
        for (const row of RealMatrix.agents) {
            const w = agentWorks(RealMatrix, row.id);
            expect(w.details.map((d) => d.feature)).toEqual(DetailFeatures);
            for (const d of w.details) {
                // An adapted cell says "works, through a workaround"; a partial or missing one says why.
                expect(d.level === "works" || !!d.reason).toBe(true);
            }
        }
        const codexState = agentWorks(RealMatrix, "codex").details.find((d) => d.feature === "state");
        expect(codexState).toMatchObject({ level: "works", matrixLevel: "adapted" });
    });

    it("says it in a few words in the picker, in English and French", () => {
        expect(pickerSummary(agentWorks(RealMatrix, "claude"), tOf(en), "en")).toBe(
            "Works with its state, approvals, plan usage, the browser, handoffs, and guides"
        );
        expect(pickerSummary(agentWorks(RealMatrix, "opencode"), tOf(en), "en")).toBe(
            "Works with its state (partly) and handoffs (partly) · not yet: approvals, plan usage, the browser, and guides"
        );
        expect(pickerSummary(agentWorks(RealMatrix, "kimi"), tOf(fr), "fr")).toBe(
            "Marche avec les guides · pas encore\u00a0: son état, les autorisations, l'usage du forfait, le navigateur et les passations"
        );
        expect(pickerSummary(agentWorks(RealMatrix, "aider"), tOf(en), "en")).toBe("Not known yet");
    });

    it("has every word in both languages", () => {
        const reasons = new Set(
            RealMatrix.agents.flatMap((a) => Object.values(a.features).map((f) => f.reason)).filter(Boolean)
        );
        const keys = [
            ...DetailFeatures.map((f) => `agentWorks.feature.${f}`),
            ...["native", "adapted", "partly", "none"].map((l) => `agentWorks.level.${l}`),
            ...[...reasons].map(reasonKey),
        ];
        for (const key of keys) {
            expect(lookup(en, key), key).toBeTypeOf("string");
            expect(lookup(fr, key), key).toBeTypeOf("string");
        }
    });

    it("shows a new agent's row with no interface change", () => {
        const adapted = { level: "adapted" as const, note: "fake", adapter: "fake" };
        const matrix = matrixWith({
            id: "aider",
            name: "Aider",
            adapter: true,
            features: { state: adapted, browsermcp: adapted },
        });
        expect(glance(agentWorks(matrix, "aider"))).toEqual({
            follows: ["state:works"],
            uses: ["browsermcp:works"],
            missing: ["approvals", "usage", "handoff", "guides"],
        });
    });

    it("renders the glance with the details closed, and runs nothing", () => {
        rpc.wshRpcCall.mockClear();
        const html = renderToStaticMarkup(<AgentWorks agent="gemini" />);
        expect(html).toContain("MoltenTerm follows:</span> its state (partly)");
        expect(html).toContain("It can use:</span> handoffs (partly) and guides");
        expect(html).toContain("Not yet:</span> approvals, plan usage, and the browser");
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain('data-testid="agent-works-details"');
        expect(rpc.wshRpcCall).not.toHaveBeenCalled();
    });

    it("gives the picker's agents their line", () => {
        const presets = {
            "agent@claude": { "display:name": "Claude Code", "display:order": 1, "agent:command": "claude" },
            "agent@codex": { "display:name": "Codex", "display:order": 2, "agent:command": "codex" },
            "agent@opus": { "display:name": "Opus", "display:order": 3, "agent:command": "claude --model opus" },
            "agent@aider": { "display:name": "Aider", "display:order": 4, "agent:command": "aider" },
        } as unknown as { [key: string]: MetaType };
        const entries = agentEntries(presets, undefined, RealMatrix);
        expect(entries.map((e) => [e.id, e.detail])).toEqual([
            ["agent:claude", "Works with its state, approvals, plan usage, the browser, handoffs, and guides"],
            ["agent:codex", "Works with its state, approvals, plan usage, the browser, handoffs, and guides"],
            ["agent:opus", "Works with its state, approvals, plan usage, the browser, handoffs, and guides"],
            ["agent:aider", "Not known yet"],
        ]);
    });
});
