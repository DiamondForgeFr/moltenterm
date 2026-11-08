// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A notification settles when the agent that asked moves on, and when its source is on screen in the focused window
// (FR-BOSS-009, AC16; FR-MC-019, #2026).

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSeenView, AgentStateInfo, AgentStatesData } from "./agent-state-model";
import {
    agentAskIds,
    AgentMovedOnWatcher,
    AgentWaitGraceMs,
    askingStatesOf,
    blocksMovedOn,
    lookedAt,
    LookSource,
    NotificationLookWatcher,
    registerNotificationPlace,
    staleAskIds,
} from "./notification-settle";
import type { MoltentermNotification } from "./notifications-model";

const T = new Date(2026, 10, 6, 14, 0, 0).getTime();

function notice(id: string, over: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return {
        id,
        source: "agent",
        kind: "warning",
        title: id,
        time: T,
        updated: T,
        read: false,
        blockid: "b1",
        actions: [],
        ...over,
    } as MoltentermNotification;
}

function agent(blockid: string, state: AgentStateInfo["state"]): AgentStateInfo {
    return { blockid, agent: "claude", firstname: blockid, state, version: 1, since: 1 };
}

function states(...infos: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(infos.map((info) => [info.blockid, info])), versions: {} };
}

describe("the agent that asked moves on (FR-MC-019, #2026)", () => {
    it("names the agents that ask and the ones that stopped asking", () => {
        const before = askingStatesOf(states(agent("b1", "waiting"), agent("b2", "error"), agent("b3", "working")));
        expect(before).toEqual({ b1: "waiting", b2: "error" });
        expect(blocksMovedOn(before, states(agent("b1", "working"), agent("b2", "error")))).toEqual(["b1"]);
        expect(blocksMovedOn(before, states(agent("b1", "waiting")))).toEqual(["b2"]);
        expect(blocksMovedOn(before, states(agent("b1", "waiting"), agent("b2", "error")))).toEqual([]);
    });

    it("picks the open waiting and error notifications of those agents, and nothing else", () => {
        const entries = [
            notice("w1"),
            notice("e1", { kind: "error" }),
            notice("done", { kind: "success" }),
            notice("other", { blockid: "b2" }),
            notice("closed", { archived: T }),
            notice("build", { source: "build" }),
        ];
        expect(agentAskIds(entries, ["b1"])).toEqual(["w1", "e1"]);
    });

    it("settles at the first reading the notifications that outlived their question, not a fresh one", () => {
        const entries = [
            notice("old", { updated: T - AgentWaitGraceMs - 1 }),
            notice("fresh", { updated: T - 1000 }),
            notice("still", { blockid: "b2", updated: T - AgentWaitGraceMs - 1 }),
        ];
        const data = states(agent("b1", "working"), agent("b2", "waiting"));
        expect(staleAskIds(entries, data, T)).toEqual(["old"]);
    });

    describe("the watcher", () => {
        let data: PrimitiveAtom<AgentStatesData>;
        let loaded: PrimitiveAtom<boolean>;
        let entries: MoltentermNotification[];
        let settled: string[][];
        let stop: () => void;

        function start() {
            stop = new AgentMovedOnWatcher(
                { dataAtom: data, loadedAtom: loaded, entries: () => entries, now: () => T },
                (ids) => settled.push(ids)
            ).start();
        }

        beforeEach(() => {
            data = atom(states(agent("b1", "waiting"), agent("b2", "working"))) as PrimitiveAtom<AgentStatesData>;
            loaded = atom(true) as PrimitiveAtom<boolean>;
            entries = [notice("w1"), notice("w2", { blockid: "b2" })];
            settled = [];
        });
        afterEach(() => stop?.());

        it("settles the notification when the agent is no longer waiting", () => {
            start();
            expect(settled).toEqual([]);
            globalStore.set(data, states(agent("b1", "working"), agent("b2", "working")));
            expect(settled).toEqual([["w1"]]);
        });

        it("settles an error notification when the agent leaves the error", () => {
            data = atom(states(agent("b1", "error"))) as PrimitiveAtom<AgentStatesData>;
            entries = [notice("e1", { kind: "error" })];
            start();
            globalStore.set(data, states(agent("b1", "idle")));
            expect(settled).toEqual([["e1"]]);
        });

        it("settles it when the agent ended and left no state", () => {
            start();
            globalStore.set(data, states(agent("b2", "working")));
            expect(settled).toEqual([["w1"]]);
        });

        it("does not settle a notification that arrived before its state, or for an agent that never asked", () => {
            start();
            entries = [...entries, notice("late", { blockid: "b3" })];
            globalStore.set(data, states(agent("b1", "waiting"), agent("b2", "working"), agent("b3", "working")));
            globalStore.set(data, states(agent("b1", "waiting"), agent("b2", "working"), agent("b3", "idle")));
            expect(settled).toEqual([]);
        });

        it("waits for the first reading, then settles what outlived its question", () => {
            loaded = atom(false) as PrimitiveAtom<boolean>;
            entries = [notice("old", { blockid: "b2", updated: T - AgentWaitGraceMs - 1 })];
            start();
            expect(settled).toEqual([]);
            globalStore.set(loaded, true);
            expect(settled).toEqual([["old"]]);
        });
    });
});

describe("the source is on screen (FR-MC-019, #2026)", () => {
    const view = (over: Partial<AgentSeenView> = {}): AgentSeenView => ({
        active: true,
        blockIds: ["t1", "t2", "t3"],
        focusedBlockId: "t1",
        ...over,
    });
    const info = (id: string, blockid: string, over: Partial<MoltentermNotification> = {}) =>
        notice(id, { kind: "info", source: "ci", blockid, ...over });

    it("settles the information of the focused pane at once, and of another pane of the tab apart", () => {
        const entries = [info("n1", "t1"), info("n2", "t2"), info("n3", "elsewhere")];
        expect(lookedAt(entries, view(), [])).toEqual({ focused: ["n1"], shown: ["n2"] });
    });

    it("sees nothing from a view that is not the one on screen in the focused window", () => {
        const entries = [info("n1", "t1")];
        expect(lookedAt(entries, view({ active: false }), [])).toEqual({ focused: [], shown: [] });
    });

    it("does not settle what asks for an answer, an agent that waits or stopped, or what is closed", () => {
        const entries = [
            info("question", "t1", { kind: "warning" }),
            notice("waiting", { blockid: "t1" }),
            notice("stopped", { blockid: "t1", kind: "error" }),
            info("closed", "t1", { archived: T }),
            info("resolved", "t1", { resolved: T }),
        ];
        expect(lookedAt(entries, view(), [])).toEqual({ focused: [], shown: [] });
    });

    it("takes the pane from a place another feature knows, as a download's page", () => {
        const download = info("d1", undefined, { source: "download", key: "download:42" });
        expect(lookedAt([download], view(), [])).toEqual({ focused: [], shown: [] });
        const stop = registerNotificationPlace((entry) => (entry.key === "download:42" ? "t1" : ""));
        expect(lookedAt([download], view())).toEqual({ focused: ["d1"], shown: [] });
        stop();
        expect(lookedAt([download], view())).toEqual({ focused: [], shown: [] });
    });

    describe("the watcher", () => {
        let source: PrimitiveAtom<LookSource>;
        let settled: string[][];
        let stop: () => void;

        const set = (entries: MoltentermNotification[], v: AgentSeenView) =>
            globalStore.set(source, { entries, view: v });
        const start = () => {
            stop = new NotificationLookWatcher(
                source,
                (ids) => {
                    settled.push(ids);
                },
                1500
            ).start();
        };

        beforeEach(() => {
            vi.useFakeTimers();
            source = atom({ entries: [], view: view({ active: false }) }) as PrimitiveAtom<LookSource>;
            settled = [];
        });
        afterEach(() => {
            stop?.();
            vi.useRealTimers();
        });

        it("settles the focused pane's information as soon as the view is the one in front", () => {
            set([info("n1", "t1")], view({ active: false }));
            start();
            expect(settled).toEqual([]);
            set([info("n1", "t1")], view());
            expect(settled).toEqual([["n1"]]);
        });

        it("settles an information that arrives in the pane in front", () => {
            start();
            set([info("n1", "t1")], view());
            expect(settled).toEqual([["n1"]]);
        });

        it("does not settle it twice while the write is on its way", () => {
            start();
            set([info("n1", "t1")], view());
            set([info("n1", "t1"), info("n2", "t3")], view());
            expect(settled).toEqual([["n1"]]);
        });

        it("leaves alone a notification the developer brought back, as the undo of a clear does", () => {
            start();
            set([info("n1", "t1")], view());
            set([info("n1", "t1", { archived: T, resolved: T })], view());
            set([info("n1", "t1")], view());
            expect(settled).toEqual([["n1"]]);
        });

        it("settles another pane of the tab only after it stayed in view", () => {
            start();
            set([info("n2", "t2")], view());
            vi.advanceTimersByTime(1499);
            expect(settled).toEqual([]);
            vi.advanceTimersByTime(1);
            expect(settled).toEqual([["n2"]]);
        });

        it("does not settle a pane that left the view before the dwell was over, or a tab in the background", () => {
            start();
            set([info("n2", "t2")], view());
            vi.advanceTimersByTime(1000);
            set([info("n2", "t2")], view({ active: false }));
            vi.advanceTimersByTime(5000);
            expect(settled).toEqual([]);
        });

        it("does not let an update of the pane in the background count", () => {
            start();
            set([info("n1", "t1")], view({ active: false }));
            set([info("n1", "t1", { updated: T + 5 })], view({ active: false }));
            vi.advanceTimersByTime(5000);
            expect(settled).toEqual([]);
        });

        it("tries again when the write failed", async () => {
            const failing = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
            vi.spyOn(console, "log").mockImplementation(() => {});
            stop = new NotificationLookWatcher(source, failing, 1500).start();
            set([info("n1", "t1")], view());
            await vi.advanceTimersByTimeAsync(0);
            set([info("n1", "t1")], view({ focusedBlockId: "t2" }));
            set([info("n1", "t1")], view());
            expect(failing).toHaveBeenCalledTimes(2);
        });
    });
});
