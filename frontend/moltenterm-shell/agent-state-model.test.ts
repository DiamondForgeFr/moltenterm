// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    agentHeaderParts,
    AgentStateInfo,
    agentStatesOfBlocks,
    agentStatesOfWorkspace,
    agentStateTitle,
    applyAgentStates,
    EmptyAgentStates,
    mostUrgentAgentState,
} from "./agent-state-model";

function info(blockid: string, state: AgentStateInfo["state"], version: number, extra?: Partial<AgentStateInfo>) {
    return { blockid, state, version, agent: "claude", agentname: "Claude Code", workspaceid: "ws1", ...extra };
}

describe("agent states", () => {
    it("keeps the newest version per block and ignores older events", () => {
        let data = applyAgentStates(EmptyAgentStates, [info("b1", "working", 1)]);
        data = applyAgentStates(data, [info("b1", "waiting", 3)]);
        data = applyAgentStates(data, [info("b1", "done", 2)]);
        expect(data.states.b1.state).toBe("waiting");
    });

    it("does not bring back a cleared agent with an older event", () => {
        let data = applyAgentStates(EmptyAgentStates, [info("b1", "working", 1)]);
        data = applyAgentStates(data, [{ blockid: "b1", version: 4, cleared: true }]);
        expect(data.states.b1).toBeUndefined();
        data = applyAgentStates(data, [info("b1", "waiting", 3)]);
        expect(data.states.b1).toBeUndefined();
    });

    it("returns the same object when nothing changes", () => {
        const data = applyAgentStates(EmptyAgentStates, [info("b1", "working", 1)]);
        expect(applyAgentStates(data, [info("b1", "working", 1)])).toBe(data);
        expect(applyAgentStates(data, [])).toBe(data);
    });

    it("shows the most urgent state: waiting, error, working, done; idle shows nothing", () => {
        const all = [info("a", "done", 1), info("b", "working", 2), info("c", "error", 3), info("d", "waiting", 4)];
        expect(mostUrgentAgentState(all).blockid).toBe("d");
        expect(mostUrgentAgentState(all.slice(0, 3)).blockid).toBe("c");
        expect(mostUrgentAgentState(all.slice(0, 2)).blockid).toBe("b");
        expect(mostUrgentAgentState(all.slice(0, 1)).blockid).toBe("a");
        expect(mostUrgentAgentState([info("e", "idle", 5)])).toBeNull();
        expect(mostUrgentAgentState([])).toBeNull();
    });

    it("groups by the tab's blocks and by workspace", () => {
        const data = applyAgentStates(EmptyAgentStates, [
            info("b1", "working", 1),
            info("b2", "waiting", 2, { workspaceid: "ws2" }),
        ]);
        expect(agentStatesOfBlocks(data, ["b1", "x"]).map((s) => s.blockid)).toEqual(["b1"]);
        expect(agentStatesOfWorkspace(data, "ws2").map((s) => s.blockid)).toEqual(["b2"]);
    });

    it("labels the header and the tooltip", () => {
        const s = info("b1", "waiting", 1, { message: "Claude needs your permission to use Bash" });
        expect(agentHeaderParts(s, "moltenterm", "feature/109-agent-states")).toEqual([
            "Claude Code",
            "moltenterm",
            "feature/109-agent-states",
        ]);
        expect(agentHeaderParts(s, "", "")).toEqual(["Claude Code"]);
        expect(agentStateTitle(s)).toBe("Claude Code: waiting for you\nClaude needs your permission to use Bash");
    });
});
