// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What makes Brokk react (FR-BOSS-007, AC12 to AC14, #1959): the facts MoltenTerm already holds, read as events for his
// mood and as expressions to ask. A new row arrives, a failure begins or is settled, an agent finishes, a wave of work
// ends, the list is cleared, a wait grows long, the developer comes back. Each rule reads the rows To handle and the
// agent states; none reads what an agent wrote.
//
// It starts with the bubble and runs while the screen is closed and the window hidden, so the mood is there when the
// developer looks (the moods live with the bubble, not with the portrait). The rules are pure; `watchBrokk` only
// listens and tells the sinks. It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { Atom, createStore } from "jotai";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { agentCallName } from "../agent-state-model";
import type { ToHandleItem, ToHandleList } from "./boss-to-handle-model";
import type { BrokkExpression } from "./brokk-ask-model";
import { dueWaits, MoodEvent, MoodFacts, MoodMemory, ReturnAfterMs, WaitRow } from "./brokk-mood";
import type { BrokkEvent, BrokkEventKind } from "./brokk-visit-events";

type Store = Pick<ReturnType<typeof createStore>, "get" | "sub">;

// The rows the developer has not acted on: what the badge counts.
export function unseenItems(list: ToHandleList): ToHandleItem[] {
    return (list?.items ?? []).filter((item) => !item.seen);
}

function isAgentRow(item: ToHandleItem): boolean {
    return item.key.startsWith("agent:");
}

// A row that waits on an answer, with the time since: what makes him impatient. A failure is not impatience, and a
// pull request that is ready does not wait on him the same way.
export function waitRows(items: ToHandleItem[]): WaitRow[] {
    return items
        .filter((item) => item.tone === "waiting" && item.since > 0)
        .map((item) => ({ key: item.key, since: item.since }));
}

// The state as the mood reads it. `nameOf` gives the sentence of a row that is not an agent, for the caption.
export function moodFactsOf(items: ToHandleItem[], nameOf: (item: ToHandleItem) => string = () => ""): MoodFacts {
    let oldest: ToHandleItem = null;
    for (const item of items) {
        if (item.tone === "waiting" && item.since > 0 && (oldest == null || item.since < oldest.since)) {
            oldest = item;
        }
    }
    return {
        failing: items.some((item) => item.tone === "error"),
        waiting: items.length,
        oldest:
            oldest == null
                ? null
                : {
                      key: oldest.key,
                      name: isAgentRow(oldest) && !oldest.lineFromNotice ? oldest.name : nameOf(oldest),
                      since: oldest.since,
                      agent: isAgentRow(oldest) && !oldest.lineFromNotice,
                  },
    };
}

export type ArrivalMemory = {
    // The rows seen at the last reading (set aside ones included); null until the first reading is in.
    known: Set<string>;
    // The projects whose pull requests have been read.
    dirs: Set<string>;
};

export const EmptyArrivals: ArrivalMemory = { known: null, dirs: new Set() };

export type ArrivalInput = {
    // Every source of rows has had its first reading: a window starting is not news.
    ready: boolean;
    // Every row, set aside or seen included.
    keys: string[];
    unseenKeys: string[];
    // The projects the Integration panel has read (their pull requests become rows when they have).
    reviewDirs: string[];
};

// The row is a pull request of a project read for the first time: part of that first reading, not an arrival.
function fromNewDir(key: string, before: ReadonlySet<string>, now: ReadonlySet<string>): boolean {
    const match = /^(?:ci|ready):(.+):\d+$/.exec(key);
    return match != null && !before.has(match[1]) && now.has(match[1]);
}

// The rows that arrived since the last reading: a key not there before and not for the developer's eyes already. The
// badge rises with them, and Brokk calls once for them (FR-BOSS-007, AC3).
export function arrivalsAfter(
    memory: ArrivalMemory,
    input: ArrivalInput
): { memory: ArrivalMemory; arrived: string[] } {
    const dirs = new Set(input.reviewDirs);
    if (!input.ready) {
        return { memory: { known: null, dirs }, arrived: [] };
    }
    const known = new Set(input.keys);
    if (memory.known == null) {
        return { memory: { known, dirs }, arrived: [] };
    }
    const arrived = input.unseenKeys.filter((key) => !memory.known.has(key) && !fromNewDir(key, memory.dirs, dirs));
    return { memory: { known, dirs }, arrived };
}

// What the agent states say changed: who finished (was at work, is done now), and how many work.
function finishedInfos(before: AgentStatesData, now: AgentStatesData): AgentStateInfo[] {
    return Object.values(now?.states ?? {}).filter(
        (info) => info?.state === "done" && before?.states?.[info?.blockid]?.state === "working"
    );
}

export function finishedNames(before: AgentStatesData, now: AgentStatesData): string[] {
    return finishedInfos(before, now).map((info) => agentCallName(info));
}

export function workingOf(data: AgentStatesData): number {
    return Object.values(data?.states ?? {}).filter((info) => info?.state === "working").length;
}

// Brokk himself works: his own session is at work. The other agents' work never counts, however many work, since the
// ring around his avatar says that he works, not that the forge does (FR-BOSS-009, AC2). `ownBlockId` is the block of
// his session; without one, he is not at work.
export function brokkWorking(data: AgentStatesData, ownBlockId: string): boolean {
    return ownBlockId != null && ownBlockId !== "" && data?.states?.[ownBlockId]?.state === "working";
}

// Brokk's own agent stopped on a prompt in his hidden terminal and waits for the developer there (#2155).
export function brokkWaiting(data: AgentStatesData, ownBlockId: string): boolean {
    return ownBlockId != null && ownBlockId !== "" && data?.states?.[ownBlockId]?.state === "waiting";
}

// The rows To handle that can bring Brokk, as the events of his visits (FR-BOSS-009, AC3, AC11): an agent that waits
// is blocked, an agent that stopped is in error, a failing CI and a pull request ready are what they say. The rows the
// developer has seen are not asked again. Any other row (a question that is no agent's, a hand-off request) is not one
// of the events of the table and stays on the badge's rows only.
export function visitEventsOfRows(items: ToHandleItem[]): BrokkEvent[] {
    const events: BrokkEvent[] = [];
    for (const item of items) {
        if (item.seen) {
            continue;
        }
        const kind = visitKindOfRow(item);
        if (kind != null) {
            events.push({ key: item.key, kind, since: item.since });
        }
    }
    return events;
}

function visitKindOfRow(item: ToHandleItem): BrokkEventKind {
    if (isAgentRow(item)) {
        return item.tone === "error" ? "error" : item.tone === "waiting" ? "blocked" : null;
    }
    if (item.key.startsWith("ci:")) {
        return "ci";
    }
    return item.key.startsWith("ready:") ? "ready" : null;
}

// The agents that just finished, as events: "an agent finished" is good news.
export function finishedEvents(before: AgentStatesData, now: AgentStatesData, at: number): BrokkEvent[] {
    return finishedInfos(before, now).map((info) => ({ key: `finished:${info.blockid}`, kind: "finished", since: at }));
}

function failureKeys(items: ToHandleItem[]): Set<string> {
    return new Set(items.filter((item) => item.tone === "error").map((item) => `${item.key}:${item.since}`));
}

export type WatchSources = {
    store: Store;
    agentsAtom: Atom<AgentStatesData>;
    agentsLoadedAtom: Atom<boolean>;
    toHandleAtom: Atom<ToHandleList>;
    now: () => number;
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
};

export type WatchSinks = {
    ask: (expression: BrokkExpression, options?: { reply?: boolean }) => void;
    note: (event: MoodEvent) => void;
    memory: () => MoodMemory;
};

// Reads the agents and the rows To handle, now and at every change, and tells the sinks. Returns the stop.
export function watchBrokk(src: WatchSources, sinks: WatchSinks): () => void {
    let ready = false;
    let failures: Set<string> = new Set();
    let before: AgentStatesData = null;
    let unseenBefore = 0;
    let timer: unknown = null;

    const impatience = (items: ToHandleItem[], quiet: boolean) => {
        const rows = waitRows(items);
        sinks.note({ type: "still", keys: rows.map((row) => row.key) });
        const waits = dueWaits(rows, sinks.memory().told, src.now());
        waits.due.forEach((wait) => sinks.note({ type: "told", key: wait.key, afterMs: wait.afterMs }));
        if (waits.due.length > 0 && !quiet) {
            sinks.ask("doubtful");
        }
        if (waits.nextAt != null) {
            timer = src.setTimer(check, Math.max(waits.nextAt - src.now(), 0) + 1);
        }
    };

    const check = () => {
        src.clearTimer(timer);
        timer = null;
        const data = src.store.get(src.agentsAtom);
        const list = src.store.get(src.toHandleAtom);
        if (!src.store.get(src.agentsLoadedAtom)) {
            ready = false;
            return;
        }
        const items = unseenItems(list);
        const parked = new Set(list.parkedKeys ?? []);
        const now = failureKeys(items);
        if (!ready) {
            ready = true;
            failures = now;
            before = data;
            unseenBefore = items.length;
            impatience(items, true);
            return;
        }

        // A failure that was not there, and the failures set aside with Later still count as not settled.
        const fresh = [...now].filter((key) => !failures.has(key));
        const kept = [...failures].filter((key) => parked.has(key.replace(/:\d+$/, "")));
        const stillFailing = new Set([...now, ...kept]);
        if (fresh.length > 0) {
            sinks.note({ type: "failed" });
            sinks.ask("frown");
        }
        const wasFailing = failures.size > 0;
        failures = stillFailing;
        if (wasFailing && stillFailing.size === 0) {
            sinks.note({ type: "settled" });
            sinks.ask("nod");
        }

        const finished = finishedNames(before, data);
        const working = workingOf(data);
        // The wave ends with the reading in which the last agent at work finished, and nothing fails.
        const waveEnds = working === 0 && finished.length > 0 && stillFailing.size === 0;
        finished.forEach((name, i) => {
            sinks.note({ type: "finished", name, all: waveEnds && i === finished.length - 1 });
        });
        if (waveEnds) {
            sinks.ask("nod");
        }
        before = data;

        if (unseenBefore > 0 && items.length === 0 && (list.parked ?? 0) === 0) {
            sinks.note({ type: "cleared" });
            sinks.ask("smile");
        }
        unseenBefore = items.length;
        impatience(items, false);
    };

    const stops = [
        src.store.sub(src.agentsAtom, check),
        src.store.sub(src.agentsLoadedAtom, check),
        src.store.sub(src.toHandleAtom, check),
    ];
    check();
    return () => {
        stops.forEach((stop) => stop());
        src.clearTimer(timer);
    };
}

// The developer's inputs, seen from the page: whether this one ends a long absence, and since when it lasted.
export function presenceAfter(last: number, now: number): { last: number; returnedSince: number } {
    const returned = last != null && now - last >= ReturnAfterMs;
    return { last: now, returnedSince: returned ? last : null };
}
