// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The developer settles a stop from the card (#1876, FR-REV-022 AC20): the stops it can settle, what the call asks
// wavesrv, and how a refusal is worded.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentStatesRoute, AgentStopSettleCommand } from "../agent-state-model";
import { wordPhrase } from "../i18n/phrase";
import { settlableAgents, settleAll, settleFromCard } from "./reviews-settle-client";
import type { AgentBarFacts } from "./reviews-upcoming-model";

const calls: { command: string; data: unknown; opts: unknown }[] = [];
let answer: unknown = { status: "settled" };

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: async (command: string, data: unknown, opts: unknown) => {
            calls.push({ command, data, opts });
            if (answer instanceof Error) {
                throw answer;
            }
            return answer;
        },
    },
}));

const Held = { text: { code: "notif.review.asks" }, english: "stopped for a decision" };

function agent(over: Partial<AgentBarFacts>): AgentBarFacts {
    return { kind: "panel", blockId: "b1", name: "Julien", state: "waiting", since: 1, held: Held, ...over };
}

beforeEach(() => {
    calls.length = 0;
    answer = { status: "settled" };
});

describe("the stops a card can settle", () => {
    it("are the panels whose stop MoltenTerm holds: not an agent's own prompt, not a working or settled agent", () => {
        const agents = [
            agent({ blockId: "held" }),
            agent({ blockId: "own", held: undefined }),
            agent({ blockId: "working", state: "working" }),
            agent({ blockId: "settled", state: "idle" }),
            agent({ blockId: "", kind: "background" }),
            agent({ blockId: "sub", kind: "subagent" }),
        ];
        expect(settlableAgents(agents).map((a) => a.blockId)).toEqual(["held"]);
        expect(settlableAgents(undefined)).toEqual([]);
    });
});

describe("settling from the card", () => {
    it("asks wavesrv's agent route for the terminal, with the note", async () => {
        expect(await settleFromCard("b1", "")).toBeNull();
        expect(calls).toHaveLength(1);
        expect(calls[0].command).toBe(AgentStopSettleCommand);
        expect(calls[0].data).toEqual({ blockid: "b1", note: "" });
        expect(calls[0].opts).toMatchObject({ route: AgentStatesRoute });
    });

    it("says why a stop could not be settled", async () => {
        answer = { status: "none" };
        expect(wordPhrase(await settleFromCard("b1", ""))).toBe("No stop waits on this agent any more.");
        answer = { status: "ownprompt" };
        expect(wordPhrase(await settleFromCard("b1", ""))).toBe(
            "This agent is blocked on a prompt of its own terminal: answer it there."
        );
        answer = new Error("route refused");
        expect(wordPhrase(await settleFromCard("b1", ""))).toContain("route refused");
    });

    it("marking the PR ready settles every stop it can, with that note, and keeps going when one fails", async () => {
        await settleAll(
            [agent({ blockId: "a" }), agent({ blockId: "own", held: undefined }), agent({ blockId: "c" })],
            "marked ready"
        );
        expect(calls.map((c) => c.data)).toEqual([
            { blockid: "a", note: "marked ready" },
            { blockid: "c", note: "marked ready" },
        ]);
        calls.length = 0;
        answer = new Error("down");
        await settleAll([agent({ blockId: "a" }), agent({ blockId: "c" })], "marked ready");
        expect(calls).toHaveLength(2);
    });
});
