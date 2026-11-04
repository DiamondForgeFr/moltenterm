// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A window's action queue, versioned (#449, FR-PERF-003, DS-PERF-004). Wave's queue released an action in a `finally`
// that a `return` inside the loop skipped past, so the queue could stop draining for good; a workspace delete bypassed
// it and raced a switch to the same workspace; and every wait on a renderer had its own timeout, about 50 s stacked.
//
// Here one `finally` only releases the running action. Each action runs with the queue's generation: a newer workspace
// switch, or a delete of the workspace a switch is going to, moves the generation, which interrupts the running
// action's waits at once (`ActionRun.race`) and fails its next `check()`, so it stops and cleans its view up. Each
// action has one readiness deadline that every wait shares.

import { isDuplicateSwitch } from "./moltenterm-spare-ready";

export const MoltentermReadinessDeadlineMs = 10000;
export const MoltentermDevReadinessDeadlineMs = 5000;

export function readinessDeadlineMs(isDev: boolean): number {
    return isDev ? MoltentermDevReadinessDeadlineMs : MoltentermReadinessDeadlineMs;
}

export type QueuedAction = { op: string; workspaceId?: string; tabId?: string };

export class SupersededError extends Error {
    constructor() {
        super("action superseded by a newer one");
        this.name = "SupersededError";
    }
}

export function isSuperseded(e: unknown): boolean {
    return e instanceof SupersededError;
}

export type ActionRun = {
    generation: number;
    // Absolute time (ms since epoch) by which every view this action waits on must be ready.
    deadline: number;
    // The one retry of an action (#450, FR-PERF-004): a view still loading at the deadline gets `ms` more, once. Returns
    // false when the action already had its retry.
    extendOnce(ms: number): boolean;
    remainingMs(): number;
    isSuperseded(): boolean;
    // Throws SupersededError once a newer action took over; call it after every await.
    check(): void;
    // Settles like `p`, or rejects with SupersededError as soon as a newer action takes over.
    race<T>(p: Promise<T>): Promise<T>;
    // Resolves when a newer action takes over (never rejects), for work that must stop by itself.
    whenSuperseded: Promise<void>;
};

// Whether `newer` takes over `older`: a workspace switch is overtaken by any newer switch and by the delete of the
// workspace it goes to; a delete's own switch afterwards (to the workspace the window lands on) by a newer switch.
// Tab actions are never overtaken.
export function supersedes(newer: QueuedAction, older: QueuedAction): boolean {
    if (older.op === "switchworkspace") {
        return (
            newer.op === "switchworkspace" ||
            (newer.op === "deleteworkspace" && newer.workspaceId === older.workspaceId)
        );
    }
    if (older.op === "deleteworkspace") {
        return newer.op === "switchworkspace";
    }
    return false;
}

function isKeptAction(entry: QueuedAction): boolean {
    return entry.op === "deleteworkspace" || entry.op === "showactivetab";
}

// The pending action `entry` folds into, when running both would end where running that one alone does (#1778): a
// close of a tab already being closed, a show of the active tab after another, and a tab switch after the tab switch
// the queue ends with (only the last tab of a burst of switches ends on screen; `replace` puts the newer one in its
// place). Anything else, a close or a new tab above all, runs in its turn: a pending action is never dropped for
// another kind of action.
function foldTarget<E extends QueuedAction>(pending: E[], entry: E): { target: E; replace: boolean } {
    if (entry.op === "closetab") {
        const same = pending.find((p) => p.op === "closetab" && p.tabId === entry.tabId);
        return same == null ? null : { target: same, replace: false };
    }
    const last = pending[pending.length - 1];
    if (last == null || last.op !== entry.op) {
        return null;
    }
    if (entry.op === "showactivetab") {
        return { target: last, replace: false };
    }
    if (entry.op === "switchtab") {
        return { target: last, replace: true };
    }
    return null;
}

export type QueueLog = (msg: string, ...args: any[]) => void;

export class WindowActionQueue<E extends QueuedAction> {
    // [0] is the running action; the others are pending.
    entries: E[] = [];
    generation = 0;
    supersedeRunning: () => void = null;
    // The calls waiting for an action (#1778): each resolves once the action it asked for, or the one it was folded
    // into, has run, so a close answers only after it happened.
    waiters = new Map<E, Array<() => void>>();

    constructor(
        readonly runAction: (entry: E, run: ActionRun) => Promise<void>,
        readonly shouldStop: () => boolean,
        readonly deadlineMs: () => number,
        readonly log: QueueLog
    ) {}

    get length(): number {
        return this.entries.length;
    }

    // A workspace switch or delete is running or pending: the window may be about to leave the workspace it shows.
    hasWorkspaceChange(): boolean {
        return this.entries.some((e) => e.op === "switchworkspace" || e.op === "deleteworkspace");
    }

    targetsWorkspace(workspaceId: string): boolean {
        return this.entries.some((e) => e.op === "switchworkspace" && e.workspaceId === workspaceId);
    }

    // Resolves once the queue has drained when this call started the drain (Wave's contract: the caller that found
    // the queue empty waits for its action); otherwise once the action it queued, or the one it was folded into, has
    // run or the window is gone (#1778). Wave answered at once, before the action ran.
    async enqueue(entry: E): Promise<void> {
        if (entry.op === "switchworkspace" && isDuplicateSwitch(this.entries, entry.workspaceId)) {
            this.log("[#283] switchworkspace already pending, coalesced", entry.workspaceId);
            await this.waitFor(this.entries[this.entries.length - 1]);
            return;
        }
        const running = this.entries[0];
        if (running == null) {
            this.entries.push(entry);
            await this.drain();
            return;
        }
        if (
            entry.op === "switchworkspace" &&
            running.op === "switchworkspace" &&
            running.workspaceId === entry.workspaceId &&
            this.entries.slice(1).every((p) => p.op === "switchworkspace")
        ) {
            this.log("[#449] switchworkspace already running, pending switches dropped", entry.workspaceId);
            for (const dropped of this.entries.slice(1)) {
                this.moveWaiters(dropped, running);
            }
            this.entries = [running];
            await this.waitFor(running);
            return;
        }
        if (supersedes(entry, running)) {
            this.log("[#449] superseding the running action", running.op, running.workspaceId ?? "", "by", entry.op);
            this.bumpGeneration();
        }
        // A pending workspace switch that a newer switch or the delete of its workspace overtakes is dropped, its
        // callers then waiting for the newer action. A delete and a show of the active tab after the view on screen
        // went (#1250) are never dropped. Everything else runs in order (#1778): Wave kept one pending action, so the
        // second of two closes asked while an action ran replaced the first, which never ran.
        const pending: E[] = [];
        for (const p of this.entries.slice(1)) {
            if (isKeptAction(p) || !supersedes(entry, p)) {
                pending.push(p);
            } else {
                this.moveWaiters(p, entry);
            }
        }
        const fold = foldTarget(pending, entry);
        if (fold == null) {
            pending.push(entry);
            this.entries = [running, ...pending];
            await this.waitFor(entry);
            return;
        }
        if (fold.replace) {
            pending[pending.indexOf(fold.target)] = entry;
            this.moveWaiters(fold.target, entry);
            this.entries = [running, ...pending];
            await this.waitFor(entry);
            return;
        }
        this.log("[#1778] same action already pending, coalesced", entry.op, entry.tabId ?? "");
        this.entries = [running, ...pending];
        await this.waitFor(fold.target);
    }

    waitFor(entry: E): Promise<void> {
        return new Promise<void>((resolve) => {
            const list = this.waiters.get(entry) ?? [];
            list.push(resolve);
            this.waiters.set(entry, list);
        });
    }

    moveWaiters(from: E, to: E) {
        const list = this.waiters.get(from);
        if (list == null) {
            return;
        }
        this.waiters.delete(from);
        this.waiters.set(to, [...(this.waiters.get(to) ?? []), ...list]);
    }

    settle(entry: E) {
        const list = this.waiters.get(entry);
        this.waiters.delete(entry);
        for (const resolve of list ?? []) {
            resolve();
        }
    }

    bumpGeneration() {
        this.generation++;
        const supersede = this.supersedeRunning;
        this.supersedeRunning = null;
        supersede?.();
    }

    makeRun(): ActionRun {
        const generation = this.generation;
        let deadline = Date.now() + this.deadlineMs();
        let extended = false;
        let resolveSuperseded: () => void;
        const whenSuperseded = new Promise<void>((resolve) => {
            resolveSuperseded = resolve;
        });
        this.supersedeRunning = resolveSuperseded;
        const superseded = whenSuperseded.then(() => {
            throw new SupersededError();
        });
        // Nobody may be racing when it fires.
        superseded.catch(() => {});
        const isStale = () => this.generation !== generation;
        const run: ActionRun = {
            generation,
            deadline,
            extendOnce: (ms: number) => {
                if (extended) {
                    return false;
                }
                extended = true;
                deadline = Date.now() + ms;
                run.deadline = deadline;
                return true;
            },
            remainingMs: () => Math.max(0, deadline - Date.now()),
            isSuperseded: isStale,
            whenSuperseded,
            check: () => {
                if (isStale()) {
                    throw new SupersededError();
                }
            },
            race: <T>(p: Promise<T>): Promise<T> => {
                if (isStale()) {
                    return Promise.reject(new SupersededError());
                }
                return Promise.race([p, superseded as Promise<never>]);
            },
        };
        return run;
    }

    async drain() {
        while (this.entries.length > 0) {
            if (this.shouldStop()) {
                const left = this.entries;
                this.entries = [];
                for (const e of left) {
                    this.settle(e);
                }
                return;
            }
            const entry = this.entries[0];
            try {
                await this.runAction(entry, this.makeRun());
            } catch (e) {
                if (isSuperseded(e)) {
                    this.log("[#449] action superseded", entry.op, entry.workspaceId ?? "");
                } else {
                    this.log("error caught in processActionQueue", e);
                }
            } finally {
                this.supersedeRunning = null;
                this.entries.shift();
                this.settle(entry);
            }
        }
    }
}
