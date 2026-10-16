// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSeenSource, AgentSeenWatcher, unreadDoneNotifications } from "./agent-seen";
import {
    AgentSeenDwellMs,
    AgentSeenView,
    AgentStateInfo,
    applyAgentStates,
    doneAgentsInView,
    EmptyAgentStates,
} from "./agent-state-model";
import { MoltentermNotification } from "./notifications-model";

function info(blockid: string, state: AgentStateInfo["state"], version: number): AgentStateInfo {
    return { blockid, state, version, agent: "claude", workspaceid: "ws1" };
}

function view(blockIds: string[], focusedBlockId: string, active = true): AgentSeenView {
    return { active, blockIds, focusedBlockId };
}

describe("doneAgentsInView (#784)", () => {
    const data = applyAgentStates(EmptyAgentStates, [
        info("b1", "done", 1),
        info("b2", "done", 2),
        info("b3", "waiting", 3),
        info("b4", "error", 4),
        info("b5", "done", 5),
    ]);

    it("splits the tab's done agents into the focused pane and the others", () => {
        const got = doneAgentsInView(data, view(["b1", "b2", "b3", "b4"], "b1"));
        expect(got.focused.map((i) => i.blockid)).toEqual(["b1"]);
        expect(got.shown.map((i) => i.blockid)).toEqual(["b2"]);
    });

    it("never sees waiting or error, nor another tab's agents", () => {
        const got = doneAgentsInView(data, view(["b3", "b4"], "b3"));
        expect(got.focused).toEqual([]);
        expect(got.shown).toEqual([]);
    });

    it("sees nothing while the view is not the active one", () => {
        const got = doneAgentsInView(data, view(["b1", "b2"], "b1", false));
        expect(got.focused).toEqual([]);
        expect(got.shown).toEqual([]);
    });
});

describe("AgentSeenWatcher (#784)", () => {
    let source: PrimitiveAtom<AgentSeenSource>;
    let sent: string[];
    let stop: () => void;

    function set(states: AgentStateInfo[], v: AgentSeenView) {
        globalStore.set(source, { data: applyAgentStates(EmptyAgentStates, states), view: v });
    }

    beforeEach(() => {
        vi.useFakeTimers();
        source = atom({ data: EmptyAgentStates, view: view([], null, false) }) as PrimitiveAtom<AgentSeenSource>;
        sent = [];
        stop = new AgentSeenWatcher(source, async (i) => {
            sent.push(`${i.blockid}:${i.version}`);
        }).start();
    });

    afterEach(() => {
        stop();
        vi.useRealTimers();
    });

    it("sees the focused pane's done agent at once, and once only", () => {
        set([info("b1", "done", 1)], view(["b1"], "b1"));
        expect(sent).toEqual(["b1:1"]);
        set([info("b1", "done", 1)], view(["b1", "b2"], "b1"));
        expect(sent).toEqual(["b1:1"]);
    });

    it("sees another pane of the tab after it stayed in view for the dwell", () => {
        set([info("b2", "done", 1)], view(["b1", "b2"], "b1"));
        vi.advanceTimersByTime(AgentSeenDwellMs - 1);
        expect(sent).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(sent).toEqual(["b2:1"]);
    });

    it("does not see a pane the user left before the dwell", () => {
        set([info("b2", "done", 1)], view(["b1", "b2"], "b1"));
        vi.advanceTimersByTime(AgentSeenDwellMs - 1);
        set([info("b2", "done", 1)], view(["b1", "b2"], "b1", false));
        vi.advanceTimersByTime(AgentSeenDwellMs * 10);
        expect(sent).toEqual([]);
    });

    it("sees nothing in a view that is not active, and never a waiting agent", () => {
        set([info("b1", "done", 1)], view(["b1"], "b1", false));
        set([info("b2", "waiting", 2)], view(["b2"], "b2"));
        vi.advanceTimersByTime(AgentSeenDwellMs * 10);
        expect(sent).toEqual([]);
    });

    it("sees a newer turn's done again", () => {
        set([info("b1", "done", 1)], view(["b1"], "b1"));
        set([info("b1", "idle", 2)], view(["b1"], "b1"));
        set([info("b1", "done", 3)], view(["b1"], "b1"));
        expect(sent).toEqual(["b1:1", "b1:3"]);
    });

    it("sends again after a failed send", async () => {
        stop();
        const calls: string[] = [];
        let fail = true;
        stop = new AgentSeenWatcher(source, async (i) => {
            calls.push(`${i.blockid}:${i.version}`);
            if (fail) {
                throw new Error("no route");
            }
        }).start();
        set([info("b1", "done", 1)], view(["b1"], "b1"));
        await vi.waitFor(() => expect(calls).toEqual(["b1:1"]));
        await Promise.resolve();
        fail = false;
        set([info("b1", "done", 1)], view(["b1", "b2"], "b1"));
        await vi.waitFor(() => expect(calls).toEqual(["b1:1", "b1:1"]));
    });
});

describe("unreadDoneNotifications (#784)", () => {
    function notif(id: string, extra: Partial<MoltentermNotification>): MoltentermNotification {
        return { id, time: 1, updated: 1, kind: "info", read: false, source: "agent", title: "x", blockid: "b1", ...extra };
    }

    it("reads the block's unread done notifications only", () => {
        const entries = [
            notif("hook-done", { titlecode: "agentdone", kind: "success" }),
            notif("signal-done", { kind: "success" }),
            notif("waiting", { titlecode: "agentwaiting", kind: "warning" }),
            notif("read", { titlecode: "agentdone", kind: "success", read: true }),
            notif("other-block", { titlecode: "agentdone", kind: "success", blockid: "b2" }),
            notif("not-agent", { kind: "success", source: "build" }),
        ];
        expect(unreadDoneNotifications(entries, "b1")).toEqual(["hook-done", "signal-done"]);
    });
});
