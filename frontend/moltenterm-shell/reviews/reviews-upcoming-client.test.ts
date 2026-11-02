// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { applyAgentStates, EmptyAgentStates } from "../agent-state-model";
import { agentsAskKey, upcomingAskForce } from "./reviews-upcoming-client";

function info(blockid: string, version: number, extra: Partial<AgentStateInfo> = {}): AgentStateInfo {
    return { blockid, agent: "claude", state: "working", started: 1000, version, ...extra };
}

describe("the Reviews view asks wavesrv again when the agents change (#1077)", () => {
    it("restored agents arriving after the first ask force the next one", () => {
        const before = applyAgentStates(EmptyAgentStates, []);
        const firstAsk = agentsAskKey(before);
        expect(upcomingAskForce(null, firstAsk)).toBe(false);
        const restored = applyAgentStates(before, [info("b1", 1), info("b2", 1, { agent: "codex" })]);
        const agents = agentsAskKey(restored);
        expect(agents).not.toBe(firstAsk);
        expect(upcomingAskForce(firstAsk, agents)).toBe(true);
    });

    it("a new run in the same terminal asks again, a state change does not", () => {
        const one = applyAgentStates(EmptyAgentStates, [info("b1", 1)]);
        const waiting = applyAgentStates(one, [info("b1", 2, { state: "waiting", since: 5000 })]);
        expect(upcomingAskForce(agentsAskKey(one), agentsAskKey(waiting))).toBe(false);
        const rerun = applyAgentStates(waiting, [info("b1", 3, { started: 9000 })]);
        expect(upcomingAskForce(agentsAskKey(waiting), agentsAskKey(rerun))).toBe(true);
    });

    it("a closed agent asks again, the order of the states does not matter", () => {
        const two = applyAgentStates(EmptyAgentStates, [info("b2", 1), info("b1", 1)]);
        const same = applyAgentStates(EmptyAgentStates, [info("b1", 1), info("b2", 1)]);
        expect(agentsAskKey(two)).toBe(agentsAskKey(same));
        const closed = applyAgentStates(two, [{ blockid: "b2", version: 2, cleared: true }]);
        expect(upcomingAskForce(agentsAskKey(two), agentsAskKey(closed))).toBe(true);
    });
});
