// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A notification settles by itself when the fact it tells is over or looked at (FR-BOSS-009, AC16; FR-MC-019, #2026):
// the agent that waited or stopped moves on, or the developer brings its source on screen in the focused window. The
// rules are pure; the two watchers only listen and tell what to settle. What asks for an answer (a question, a
// permission, an agent that waits or stopped) is never settled by looking: only the answer, the agent moving on, an
// action or Ignorer end it.

import { globalStore } from "@/app/store/jotaiStore";
import { Atom } from "jotai";
import { AgentSeenDwellMs, AgentSeenView, AgentStateInfo, AgentStatesData } from "./agent-state-model";
import { checkNeedsAnswer } from "./notification-attention";
import { checkGoToTerminal, MoltentermNotification } from "./notifications-model";

// A notification older than this, whose agent does not ask at the first reading, is settled: it outlived the question.
// A fresh one is left alone, since the state may reach the window a moment after the notification.
export const AgentWaitGraceMs = 10000;

const AskingStates = ["waiting", "error"];

export function checkAsking(info: AgentStateInfo): boolean {
    return info != null && AskingStates.includes(info.state);
}

// The state of each agent that asks the developer for something, by block.
export function askingStatesOf(data: AgentStatesData): Record<string, string> {
    const rtn: Record<string, string> = {};
    for (const info of Object.values(data?.states ?? {})) {
        if (checkAsking(info)) {
            rtn[info.blockid] = info.state;
        }
    }
    return rtn;
}

// The blocks whose agent asked and does not any more: it was answered, wherever, or it moved on, or it ended.
export function blocksMovedOn(before: Record<string, string>, data: AgentStatesData): string[] {
    return Object.keys(before ?? {}).filter((blockId) => !checkAsking(data?.states?.[blockId]));
}

// The open notifications of these agents that wait or stopped.
export function agentAskIds(entries: MoltentermNotification[], blockIds: string[]): string[] {
    const wanted = new Set(blockIds);
    return entries.filter((e) => checkGoToTerminal(e) && wanted.has(e.blockid)).map((e) => e.id);
}

// At the first reading: the notifications of agents that do not ask any more, left from before the window started.
export function staleAskIds(entries: MoltentermNotification[], data: AgentStatesData, now: number): string[] {
    return entries
        .filter(
            (e) =>
                checkGoToTerminal(e) &&
                !checkAsking(data?.states?.[e.blockid]) &&
                now - (e.updated ?? e.time) >= AgentWaitGraceMs
        )
        .map((e) => e.id);
}

export type AgentMovedOnSources = {
    dataAtom: Atom<AgentStatesData>;
    // True once the first reading is in: what arrives before it is a window starting, not an agent moving on.
    loadedAtom: Atom<boolean>;
    entries: () => MoltentermNotification[];
    now: () => number;
};

// Follows the agent states and settles the notifications of the agents that stopped asking. The first reading settles
// what was left from before; later, a notification is settled only by a change seen here, so one that arrives before
// its state is never settled for lack of it.
export class AgentMovedOnWatcher {
    sources: AgentMovedOnSources;
    settle: (ids: string[]) => void;
    asking: Record<string, string> = null;

    constructor(sources: AgentMovedOnSources, settle: (ids: string[]) => void) {
        this.sources = sources;
        this.settle = settle;
    }

    start(): () => void {
        this.apply();
        const stops = [
            globalStore.sub(this.sources.dataAtom, () => this.apply()),
            globalStore.sub(this.sources.loadedAtom, () => this.apply()),
        ];
        return () => stops.forEach((stop) => stop());
    }

    apply(): void {
        if (!globalStore.get(this.sources.loadedAtom)) {
            return;
        }
        const data = globalStore.get(this.sources.dataAtom);
        const asking = askingStatesOf(data);
        const first = this.asking == null;
        const ids = first
            ? staleAskIds(this.sources.entries(), data, this.sources.now())
            : agentAskIds(this.sources.entries(), blocksMovedOn(this.asking, data));
        this.asking = asking;
        if (ids.length > 0) {
            this.settle(ids);
        }
    }
}

// ---- looking at the source ---------------------------------------------------------------------------------------------

// Where else than its own pane a notification comes from, as the block that shows it: the page a download started from.
// Registered by the code that knows it, so that this file knows no download.
export type NotificationPlace = (entry: MoltentermNotification) => string;

const places: NotificationPlace[] = [];

export function registerNotificationPlace(place: NotificationPlace): () => void {
    places.push(place);
    return () => {
        const at = places.indexOf(place);
        if (at >= 0) {
            places.splice(at, 1);
        }
    };
}

export function placeOfEntry(entry: MoltentermNotification, extra: NotificationPlace[] = places): string {
    if (entry.blockid) {
        return entry.blockid;
    }
    for (const place of extra) {
        const blockId = place(entry);
        if (blockId) {
            return blockId;
        }
    }
    return null;
}

// What looking at the source settles: the information a notification brings, not what asks for an answer.
export function checkSettledByLooking(entry: MoltentermNotification): boolean {
    return entry.resolved == null && entry.archived == null && !checkNeedsAnswer(entry) && !checkGoToTerminal(entry);
}

// The notifications whose source is on screen in the focused window: `focused` for the focused pane, `shown` for another
// pane of the tab. A view that is not active (a background tab, another workspace, an unfocused window) sees nothing.
export function lookedAt(
    entries: MoltentermNotification[],
    view: AgentSeenView,
    extra: NotificationPlace[] = places
): { focused: string[]; shown: string[] } {
    const rtn = { focused: [] as string[], shown: [] as string[] };
    if (!view?.active) {
        return rtn;
    }
    for (const entry of entries) {
        if (!checkSettledByLooking(entry)) {
            continue;
        }
        const blockId = placeOfEntry(entry, extra);
        if (blockId == null) {
            continue;
        }
        if (blockId === view.focusedBlockId) {
            rtn.focused.push(entry.id);
        } else if (view.blockIds.includes(blockId)) {
            rtn.shown.push(entry.id);
        }
    }
    return rtn;
}

export type LookSource = { entries: MoltentermNotification[]; view: AgentSeenView };

// Follows what the view shows and settles a notification once its source has been in view: at once for the focused pane,
// after AgentSeenDwellMs of continuous view for the others. Kept apart from the app's atoms so the timing is tested with
// fake timers.
export class NotificationLookWatcher {
    source: Atom<LookSource>;
    settle: (ids: string[]) => Promise<void> | void;
    dwellMs: number;
    pending = new Map<string, ReturnType<typeof setTimeout>>();
    // Kept for good, not only while the write is on its way: the undo of a clear brings a notification back, and the
    // developer who asked for it back must find it, even with its source still on screen.
    sent = new Set<string>();

    constructor(
        source: Atom<LookSource>,
        settle: (ids: string[]) => Promise<void> | void,
        dwellMs: number = AgentSeenDwellMs
    ) {
        this.source = source;
        this.settle = settle;
        this.dwellMs = dwellMs;
    }

    start(): () => void {
        this.apply();
        const unsubscribe = globalStore.sub(this.source, () => this.apply());
        return () => {
            unsubscribe();
            for (const timer of this.pending.values()) {
                clearTimeout(timer);
            }
            this.pending.clear();
        };
    }

    apply(): void {
        const { entries, view } = globalStore.get(this.source);
        const { focused, shown } = lookedAt(entries, view);
        focused.forEach((id) => this.cancel(id));
        this.send(focused);
        const kept = new Set(shown);
        for (const id of shown) {
            if (this.pending.has(id) || this.sent.has(id)) {
                continue;
            }
            this.pending.set(
                id,
                setTimeout(() => {
                    this.pending.delete(id);
                    this.send([id]);
                }, this.dwellMs)
            );
        }
        for (const id of [...this.pending.keys()]) {
            if (!kept.has(id)) {
                this.cancel(id);
            }
        }
    }

    cancel(id: string): void {
        const timer = this.pending.get(id);
        if (timer == null) {
            return;
        }
        clearTimeout(timer);
        this.pending.delete(id);
    }

    send(ids: string[]): void {
        const fresh = ids.filter((id) => !this.sent.has(id));
        if (fresh.length === 0) {
            return;
        }
        fresh.forEach((id) => this.sent.add(id));
        const failed = (e: any) => {
            fresh.forEach((id) => this.sent.delete(id));
            console.log("notification settle:", e?.message ?? e);
        };
        try {
            Promise.resolve(this.settle(fresh)).catch(failed);
        } catch (e) {
            failed(e);
        }
    }
}
