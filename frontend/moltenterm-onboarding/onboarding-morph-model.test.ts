// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { MoltenModStatus } from "../molten/molten-host";
import type { OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";
import {
    copyDemoCommand,
    enabledModIds,
    morphAgent,
    morphRequests,
    newMod,
    readMorphedMod,
} from "./onboarding-morph-model";
import { EmptyOnboardingState, OnboardingState } from "./onboarding-state";

function agent(id: string, patch: Partial<OnboardingAgent> = {}): OnboardingAgent {
    return {
        id,
        name: id,
        path: "/p",
        invocation: "/morph <request>",
        format: "skill",
        installed: true,
        guides: [],
        found: true,
        executable: id,
        ...patch,
    };
}

const list: OnboardingAgents = {
    version: "1.0.0",
    agents: [
        agent("claude-code", { executable: "claude" }),
        agent("codex", { invocation: "$morph <request>", found: false }),
        agent("kimi", { invocation: "/skill:morph <request>", declined: true }),
    ],
};

function chose(id: string): OnboardingState {
    return { ...EmptyOnboardingState, data: { agent: { agent: id } } };
}

function mod(id: string, patch: Partial<MoltenModStatus> = {}): MoltenModStatus {
    return { id, path: `/mods/${id}`, state: "active", commands: [], ...patch };
}

describe("your first morph step (FR-ONB-003)", () => {
    it("starts the agent chosen in step 1 only while it is found with its guide", () => {
        expect(morphAgent(chose("claude-code"), list)?.executable).toBe("claude");
        expect(morphAgent(chose("codex"), list)).toBeNull();
        expect(morphAgent(chose("kimi"), list)).toBeNull();
        expect(morphAgent(EmptyOnboardingState, list)).toBeNull();
        expect(morphAgent(chose("claude-code"), null)).toBeNull();
    });

    it("proposes one request and two alternatives in the agent's syntax", () => {
        const requests = morphRequests(agent("codex", { invocation: "$morph <request>" }));
        expect(requests).toHaveLength(3);
        expect(requests[0]).toBe("$morph add a command that shows the current git branch in a box");
        expect(morphRequests(agent("kimi", { invocation: "/skill:morph <request>" }))[1]).toMatch(/^\/skill:morph /);
        expect(morphRequests(null)).toEqual([]);
    });

    it("ticks on a user mod enabled after the baseline only", () => {
        const before = [mod("copy-box", { builtin: true }), mod("old"), mod("off", { state: "disabled" })];
        const baseline = enabledModIds(before);
        expect(baseline).toEqual(["old"]);
        expect(newMod(before, baseline)).toBeNull();
        expect(newMod([...before, mod("branch-box", { state: "untrusted" })], baseline)).toBeNull();
        expect(newMod([...before, mod("branch-box", { name: "Branch box", commands: ["branch"] })], baseline)).toEqual({
            id: "branch-box",
            name: "Branch box",
            commands: ["branch"],
        });
        expect(newMod([...before, mod("pending-one", { state: "pending" })], baseline)?.name).toBe("pending-one");
        expect(newMod([mod("x")], undefined)).toBeNull();
    });

    it("reads the recorded mod back from the step's data", () => {
        expect(readMorphedMod({ mod: { id: "a", name: "", commands: ["x", 3] } })).toEqual({
            id: "a",
            name: "a",
            commands: ["x"],
        });
        expect(readMorphedMod({})).toBeNull();
        expect(readMorphedMod(null)).toBeNull();
    });

    it("shows the copy box with the same line molten copy takes", () => {
        expect(copyDemoCommand("Your first box")).toBe('molten copy --title "Your first box" Hello from MoltenTerm');
    });
});
