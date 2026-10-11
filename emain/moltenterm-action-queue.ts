// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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

export type QueuedAction = { op: string; workspaceId?: string };

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

export type QueueLog = (msg: string, ...args: any[]) => void;

export class WindowActionQueue<E extends QueuedAction> {
    // [0] is the running action; the others are pending.
    entries: E[] = [];
    generation = 0;
    supersedeRunning: () => void = null;

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
    // the queue empty waits for its action); otherwise at once.
    async enqueue(entry: E): Promise<void> {
        if (entry.op === "switchworkspace" && isDuplicateSwitch(this.entries, entry.workspaceId)) {
            this.log("[#283] switchworkspace already pending, coalesced", entry.workspaceId);
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
            this.entries = [running];
            return;
        }
        if (supersedes(entry, running)) {
            this.log("[#449] superseding the running action", running.op, running.workspaceId ?? "", "by", entry.op);
            this.bumpGeneration();
        }
        // A delete is never dropped nor replaced; otherwise the newest pending action replaces the previous one, as in
        // Wave (there is no point running an action that is about to be overwritten).
        const pending = this.entries.slice(1).filter((p) => p.op === "deleteworkspace" || !supersedes(entry, p));
        const last = pending[pending.length - 1];
        if (last != null && last.op !== "deleteworkspace" && entry.op !== "deleteworkspace") {
            pending[pending.length - 1] = entry;
        } else {
            pending.push(entry);
        }
        this.entries = [running, ...pending];
    }

    bumpGeneration() {
        this.generation++;
        const supersede = this.supersedeRunning;
        this.supersedeRunning = null;
        supersede?.();
    }

    makeRun(): ActionRun {
        const generation = this.generation;
        const deadline = Date.now() + this.deadlineMs();
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
        return {
            generation,
            deadline,
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
    }

    async drain() {
        while (this.entries.length > 0) {
            if (this.shouldStop()) {
                this.entries = [];
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
            }
        }
    }
}
