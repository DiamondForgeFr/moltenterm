// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));

import { panelCapabilities } from "../command-panel/panel-context";
import { matchingProviders } from "../command-panel/panel-registry";
import { AgentProvider, unavailableAgentSection } from "../command-panel/providers/agent";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import {
    ActionFeatures,
    actionGate,
    gateAlternative,
    gateMessage,
    gateReason,
    morphWorks,
    type AgentAction,
} from "./agent-action-gate";
import { BuiltMatrix, type FeatureMatrix } from "./agent-features-model";

const Matrix: FeatureMatrix = {
    asof: "2026-11-01",
    features: [],
    agents: [
        {
            id: "claude",
            name: "Claude Code",
            adapter: true,
            features: {
                guides: { level: "native" },
                effort: { level: "native" },
                browsermcp: { level: "adapted", note: "per run" },
            },
        },
        {
            id: "opencode",
            name: "OpenCode",
            adapter: false,
            features: {
                guides: { level: "none", reason: "noskills" },
                effort: { level: "none", reason: "noadapter" },
                commands: { level: "none", reason: "noadapter" },
                resume: { level: "none", reason: "noadapter" },
                handoff: { level: "process-only", reason: "nomcp" },
            },
        },
    ],
};

function lookup(dict: any, key: string): unknown {
    return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

describe("action gate (FR-AGC-005)", () => {
    it("lets an action run where the matrix says it works, and stops it where it says none", () => {
        expect(actionGate(Matrix, "claude", "morph").works).toBe(true);
        expect(actionGate(Matrix, "claude", "send").works).toBe(true);
        expect(actionGate(Matrix, "opencode", "morph")).toMatchObject({
            works: false,
            level: "none",
            agentName: "OpenCode",
        });
        expect(actionGate(Matrix, "opencode", "effort").works).toBe(false);
    });

    it("treats an agent or a feature the matrix does not know as none, never as working", () => {
        expect(actionGate(Matrix, "someagent", "effort").works).toBe(false);
        expect(actionGate(Matrix, "claude", "resume").works).toBe(false);
    });

    it("never blocks without a matrix nor without an agent: the action's own errors speak", () => {
        expect(actionGate(null, "opencode", "morph")).toMatchObject({ works: true, level: "unknown" });
        expect(actionGate(Matrix, "", "morph").works).toBe(true);
    });

    it("types /morph into an agent the matrix does not know, as plain text, but not into one whose guides are none", () => {
        expect(morphWorks(Matrix, "claude")).toBe(true);
        expect(morphWorks(Matrix, "someagent")).toBe(true);
        expect(morphWorks(Matrix, "opencode")).toBe(false);
    });

    it("says why and what to do instead, in plain words, naming the agent", () => {
        const gate = actionGate(Matrix, "opencode", "morph");
        expect(gateReason(gate)).toContain("OpenCode");
        expect(gateReason(gate)).toContain("/morph");
        expect(gateAlternative(gate)).toContain("another agent");
        expect(gateMessage(gate)).toBe(`${gateReason(gate)} ${gateAlternative(gate)}`);
        expect(gateMessage(actionGate(Matrix, "claude", "morph"))).toBe("");
        expect(gateMessage(gate, "OpenCode 1.2")).toContain("OpenCode 1.2");
    });

    it("has a reason and an alternative in both languages for every action, with the same placeholders", () => {
        for (const action of Object.keys(ActionFeatures) as AgentAction[]) {
            for (const part of ["none", "alt"]) {
                const key = `agc.gate.${action}.${part}`;
                const a = lookup(en, key) as string;
                const b = lookup(fr, key) as string;
                expect(typeof a, key).toBe("string");
                expect(typeof b, key).toBe("string");
                expect(b.match(/\{\w+\}/g)?.sort()).toEqual(a.match(/\{\w+\}/g)?.sort());
            }
        }
    });

    // Every agent of the catalog (#1698), named from its row: a none cell explains itself for each of them.
    it("covers every agent of the shipped matrix, each action either working or saying why", () => {
        const ids = BuiltMatrix.agents.map((a) => a.id);
        expect(ids).toEqual(
            expect.arrayContaining(["antigravity", "copilot", "cursor", "grok", "vibe", "kimi", "qwen", "opencode"])
        );
        for (const row of BuiltMatrix.agents) {
            for (const action of Object.keys(ActionFeatures) as AgentAction[]) {
                const gate = actionGate(BuiltMatrix, row.id, action);
                expect(gate.level, `${row.id} ${action}`).not.toBe("unknown");
                if (!gate.works) {
                    expect(gateMessage(gate), `${row.id} ${action}`).toContain(row.name);
                }
            }
        }
        expect(actionGate(BuiltMatrix, "copilot", "effort").works).toBe(false);
        expect(actionGate(BuiltMatrix, "grok", "morph").works).toBe(true);
    });
});

describe("Agent section of an agent without commands (FR-AGC-005)", () => {
    const ctx = (agent: string, extra: any = {}): any => {
        const info: any = { blockid: "b1", agent, agentname: agent === "opencode" ? "OpenCode" : "Claude Code" };
        return {
            blockId: "b1",
            view: "term",
            meta: {},
            agent: info,
            capabilities: panelCapabilities({ view: "term", meta: {}, agent: info, waveMenu: false }),
            ...extra,
        };
    };

    it("offers the actions that do not work there, each saying why when chosen", async () => {
        const section = unavailableAgentSection(ctx("opencode"), Matrix);
        expect(section.items.map((i) => i.id)).toEqual([
            "agent:gated:commands",
            "agent:gated:effort",
            "agent:gated:resume",
        ]);
        const effort = section.items[1] as any;
        expect(effort.detail).toBe(en.agc.gate.notHere);
        const feedback = await effort.run();
        expect(feedback.role).toBe("alert");
        expect(feedback.message).toContain("OpenCode");
        expect(feedback.actions).toBeUndefined();
    });

    it("shows the agent's terminal as the way forward when the panel drives another one", async () => {
        const reveal = vi.fn();
        const section = unavailableAgentSection(ctx("opencode", { revealAgent: reveal }), Matrix);
        const feedback = await (section.items[0] as any).run();
        expect(feedback.actions[0].run()).toBe("away");
        expect(reveal).toHaveBeenCalled();
    });

    it("leaves an agent with its command table to its own section, and says nothing without a matrix", () => {
        expect(unavailableAgentSection(ctx("claude"), Matrix)).toBeNull();
        expect(unavailableAgentSection(ctx("opencode"), null)).toBeNull();
    });

    it("gives the shipped matrix's agents without a command table an Agent section", () => {
        for (const id of ["copilot", "cursor", "grok", "vibe", "antigravity", "kimi", "qwen", "opencode"]) {
            expect(matchingProviders(ctx(id), [AgentProvider]), id).toHaveLength(1);
        }
    });
});
