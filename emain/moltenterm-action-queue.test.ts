// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ActionRun,
    isSuperseded,
    QueuedAction,
    readinessDeadlineMs,
    supersedes,
    WindowActionQueue,
} from "./moltenterm-action-queue";

type Entry = QueuedAction & { id: string; behave?: "return" | "throw" | "throw-late" | "wait" };

function makeQueue(opts: { stop?: () => boolean } = {}) {
    const ran: string[] = [];
    const done: string[] = [];
    const outcomes: Record<string, string> = {};
    const runs: Record<string, ActionRun> = {};
    const queue = new WindowActionQueue<Entry>(
        async (entry, run) => {
            ran.push(entry.id);
            runs[entry.id] = run;
            try {
                if (entry.behave === "return") {
                    return;
                }
                if (entry.behave === "throw") {
                    throw new Error("boom");
                }
                await run.race(new Promise((r) => setTimeout(r, 100)));
                run.check();
                if (entry.behave === "throw-late") {
                    throw new Error("late boom");
                }
                if (entry.behave === "wait") {
                    await run.race(new Promise((r) => setTimeout(r, 100000)));
                }
                done.push(entry.id);
                outcomes[entry.id] = "done";
            } catch (e) {
                outcomes[entry.id] = isSuperseded(e) ? "superseded" : "error";
                throw e;
            }
        },
        opts.stop ?? (() => false),
        () => 5000,
        () => {}
    );
    return { queue, ran, done, outcomes, runs };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("readinessDeadlineMs", () => {
    it("is 10 s in production and 5 s in dev", () => {
        expect(readinessDeadlineMs(false)).toBe(10000);
        expect(readinessDeadlineMs(true)).toBe(5000);
    });
});

describe("supersedes", () => {
    it("lets any newer switch, and the delete of its target, take over a switch", () => {
        const sw = { op: "switchworkspace", workspaceId: "a" };
        expect(supersedes({ op: "switchworkspace", workspaceId: "b" }, sw)).toBe(true);
        expect(supersedes({ op: "deleteworkspace", workspaceId: "a" }, sw)).toBe(true);
        expect(supersedes({ op: "deleteworkspace", workspaceId: "b" }, sw)).toBe(false);
        expect(supersedes({ op: "createtab" }, sw)).toBe(false);
    });

    it("never takes over a tab action, and lets only a switch take over a delete", () => {
        expect(supersedes({ op: "switchworkspace", workspaceId: "a" }, { op: "createtab" })).toBe(false);
        expect(supersedes({ op: "deleteworkspace", workspaceId: "a" }, { op: "closetab" })).toBe(false);
        const del = { op: "deleteworkspace", workspaceId: "a" };
        expect(supersedes({ op: "switchworkspace", workspaceId: "b" }, del)).toBe(true);
        expect(supersedes({ op: "deleteworkspace", workspaceId: "b" }, del)).toBe(false);
    });
});

describe("WindowActionQueue: never stuck", () => {
    it.each(["return", "throw", "throw-late"] as const)("runs the next action after one that does %s", async (b) => {
        const { queue, ran, done } = makeQueue();
        const first = queue.enqueue({ op: "createtab", id: "first", behave: b });
        queue.enqueue({ op: "closetab", id: "next" });
        await vi.advanceTimersByTimeAsync(500);
        await first;
        expect(ran).toEqual(["first", "next"]);
        expect(done).toContain("next");
        expect(queue.length).toBe(0);
        queue.enqueue({ op: "createtab", id: "later" });
        await vi.advanceTimersByTimeAsync(500);
        expect(done).toContain("later");
    });

    it("runs a superseded action's successor at once, without waiting for its timers", async () => {
        const { queue, done, outcomes } = makeQueue();
        queue.enqueue({ op: "switchworkspace", workspaceId: "a", id: "a", behave: "wait" });
        await vi.advanceTimersByTimeAsync(150);
        queue.enqueue({ op: "switchworkspace", workspaceId: "b", id: "b" });
        await vi.advanceTimersByTimeAsync(150);
        expect(outcomes.a).toBe("superseded");
        expect(done).toEqual(["b"]);
        expect(queue.length).toBe(0);
    });

    it("stops and empties when the window is gone", async () => {
        let stopped = false;
        const { queue, ran } = makeQueue({ stop: () => stopped });
        queue.enqueue({ op: "createtab", id: "first" });
        queue.enqueue({ op: "closetab", id: "second" });
        stopped = true;
        await vi.advanceTimersByTimeAsync(500);
        expect(ran).toEqual(["first"]);
        expect(queue.length).toBe(0);
    });

    it("resolves the call that started the drain once the queue is empty, the others at once", async () => {
        const { queue } = makeQueue();
        let firstDone = false;
        let secondDone = false;
        queue.enqueue({ op: "createtab", id: "first" }).then(() => (firstDone = true));
        queue.enqueue({ op: "closetab", id: "second" }).then(() => (secondDone = true));
        await vi.advanceTimersByTimeAsync(0);
        expect(secondDone).toBe(true);
        expect(firstDone).toBe(false);
        await vi.advanceTimersByTimeAsync(300);
        expect(firstDone).toBe(true);
    });
});

describe("WindowActionQueue: generations", () => {
    it("a delete of the workspace a running switch goes to supersedes it, then runs", async () => {
        const { queue, ran, outcomes } = makeQueue();
        queue.enqueue({ op: "switchworkspace", workspaceId: "x", id: "switch-x", behave: "wait" });
        await vi.advanceTimersByTimeAsync(10);
        queue.enqueue({ op: "deleteworkspace", workspaceId: "x", id: "delete-x" });
        await vi.advanceTimersByTimeAsync(500);
        expect(outcomes["switch-x"]).toBe("superseded");
        expect(ran).toEqual(["switch-x", "delete-x"]);
        expect(outcomes["delete-x"]).toBe("done");
    });

    it("a delete of another workspace waits behind the running switch", async () => {
        const { queue, ran, outcomes } = makeQueue();
        queue.enqueue({ op: "switchworkspace", workspaceId: "x", id: "switch-x" });
        await vi.advanceTimersByTimeAsync(10);
        queue.enqueue({ op: "deleteworkspace", workspaceId: "y", id: "delete-y" });
        await vi.advanceTimersByTimeAsync(500);
        expect(outcomes["switch-x"]).toBe("done");
        expect(ran).toEqual(["switch-x", "delete-y"]);
    });

    it("tab actions are never superseded", async () => {
        const { queue, outcomes } = makeQueue();
        queue.enqueue({ op: "createtab", id: "tab" });
        await vi.advanceTimersByTimeAsync(10);
        queue.enqueue({ op: "switchworkspace", workspaceId: "a", id: "a" });
        await vi.advanceTimersByTimeAsync(500);
        expect(outcomes.tab).toBe("done");
        expect(outcomes.a).toBe("done");
    });

    it("check() and race() report the takeover after every await", async () => {
        const { queue, runs } = makeQueue();
        queue.enqueue({ op: "switchworkspace", workspaceId: "a", id: "a", behave: "wait" });
        await vi.advanceTimersByTimeAsync(10);
        const run = runs.a;
        expect(run.isSuperseded()).toBe(false);
        expect(() => run.check()).not.toThrow();
        queue.enqueue({ op: "switchworkspace", workspaceId: "b", id: "b", behave: "wait" });
        expect(run.isSuperseded()).toBe(true);
        expect(() => run.check()).toThrow();
        await expect(run.race(Promise.resolve(1))).rejects.toSatisfy(isSuperseded);
    });

    it("gives every action its own deadline", async () => {
        const { queue, runs } = makeQueue();
        queue.enqueue({ op: "createtab", id: "first" });
        queue.enqueue({ op: "closetab", id: "second" });
        const start = Date.now();
        await vi.advanceTimersByTimeAsync(500);
        expect(runs.first.deadline).toBe(start + 5000);
        expect(runs.second.deadline).toBeGreaterThanOrEqual(start + 5100);
        expect(runs.second.remainingMs()).toBeLessThanOrEqual(5000);
    });
});

describe("WindowActionQueue: pending actions", () => {
    function pendingIds(queue: WindowActionQueue<Entry>) {
        return queue.entries.slice(1).map((e) => e.id);
    }

    it("replaces the pending action by a newer one, as Wave did", () => {
        const { queue } = makeQueue();
        queue.enqueue({ op: "createtab", id: "running" });
        queue.enqueue({ op: "createtab", id: "p1" });
        queue.enqueue({ op: "closetab", id: "p2" });
        expect(pendingIds(queue)).toEqual(["p2"]);
    });

    it("never drops nor replaces a delete", () => {
        const { queue } = makeQueue();
        queue.enqueue({ op: "createtab", id: "running" });
        queue.enqueue({ op: "switchworkspace", workspaceId: "a", id: "switch-a" });
        queue.enqueue({ op: "deleteworkspace", workspaceId: "b", id: "delete-b" });
        queue.enqueue({ op: "switchworkspace", workspaceId: "c", id: "switch-c" });
        queue.enqueue({ op: "switchworkspace", workspaceId: "d", id: "switch-d" });
        expect(pendingIds(queue)).toEqual(["delete-b", "switch-d"]);
    });

    it("a delete drops a pending switch to the workspace it deletes", () => {
        const { queue } = makeQueue();
        queue.enqueue({ op: "createtab", id: "running" });
        queue.enqueue({ op: "switchworkspace", workspaceId: "x", id: "switch-x" });
        queue.enqueue({ op: "deleteworkspace", workspaceId: "x", id: "delete-x" });
        expect(pendingIds(queue)).toEqual(["delete-x"]);
    });

    it("coalesces a click on the workspace the queue already ends with (#283)", () => {
        const { queue } = makeQueue();
        queue.enqueue({ op: "switchworkspace", workspaceId: "a", id: "running" });
        queue.enqueue({ op: "switchworkspace", workspaceId: "a", id: "again" });
        expect(queue.generation).toBe(0);
        expect(queue.length).toBe(1);
    });

    it("a click back on the workspace a running switch goes to drops the switches pending after it", () => {
        const { queue } = makeQueue();
        queue.enqueue({ op: "switchworkspace", workspaceId: "a", id: "running" });
        queue.enqueue({ op: "switchworkspace", workspaceId: "b", id: "switch-b" });
        const generation = queue.generation;
        queue.enqueue({ op: "switchworkspace", workspaceId: "a", id: "back-to-a" });
        expect(queue.generation).toBe(generation);
        expect(queue.entries.map((e) => e.id)).toEqual(["running"]);
    });

    it("reports a workspace change under way and the workspaces it targets", () => {
        const { queue } = makeQueue();
        expect(queue.hasWorkspaceChange()).toBe(false);
        queue.enqueue({ op: "createtab", id: "running" });
        expect(queue.hasWorkspaceChange()).toBe(false);
        queue.enqueue({ op: "switchworkspace", workspaceId: "a", id: "switch-a" });
        expect(queue.hasWorkspaceChange()).toBe(true);
        expect(queue.targetsWorkspace("a")).toBe(true);
        expect(queue.targetsWorkspace("b")).toBe(false);
    });
});
