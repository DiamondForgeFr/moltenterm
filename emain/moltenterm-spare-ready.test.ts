// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireReadyView, awaitViewInitialized, isDuplicateSwitch, ReadyTrackedView } from "./moltenterm-spare-ready";

type FakeView = ReadyTrackedView & { resolve: () => void; destroyed: number };

function makeView(opts: { ready?: boolean } = {}): FakeView {
    let resolve: () => void;
    const initPromise = new Promise<void>((r) => {
        resolve = r;
    });
    const view: FakeView = {
        isInitialized: false,
        isDestroyed: false,
        initPromise,
        destroyed: 0,
        destroy() {
            view.destroyed++;
            view.isDestroyed = true;
        },
        resolve: () => {
            view.isInitialized = true;
            resolve();
        },
    };
    if (opts.ready) {
        view.resolve();
    }
    return view;
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("awaitViewInitialized", () => {
    it("answers at once for a view that was ready before it was taken", async () => {
        const view = makeView({ ready: true });
        await expect(awaitViewInitialized(view, 5000)).resolves.toBe(true);
    });

    it("answers true when the view becomes ready in time", async () => {
        const view = makeView();
        const result = awaitViewInitialized(view, 5000);
        await vi.advanceTimersByTimeAsync(1200);
        view.resolve();
        await expect(result).resolves.toBe(true);
    });

    it("gives up on a view that never becomes ready", async () => {
        const view = makeView();
        const result = awaitViewInitialized(view, 5000);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toBe(false);
    });

    it("refuses a destroyed view", async () => {
        const view = makeView({ ready: true });
        view.destroy();
        await expect(awaitViewInitialized(view, 5000)).resolves.toBe(false);
    });
});

describe("acquireReadyView", () => {
    it("uses a spare that was ready before it was taken, without waiting", async () => {
        const spare = makeView({ ready: true });
        const makeFresh = vi.fn(() => makeView());
        const rtn = await acquireReadyView(
            () => spare,
            makeFresh,
            () => {}
        );
        expect(rtn).toEqual({ view: spare, ready: true });
        expect(makeFresh).not.toHaveBeenCalled();
    });

    it("replaces a spare that never gets ready by a fresh view", async () => {
        const spare = makeView();
        const fresh = makeView();
        const log = vi.fn();
        const result = acquireReadyView(
            () => spare,
            () => fresh,
            log,
            5000,
            15000
        );
        await vi.advanceTimersByTimeAsync(5000);
        fresh.resolve();
        const rtn = await result;
        expect(rtn).toEqual({ view: fresh, ready: true });
        expect(spare.destroyed).toBe(1);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("dropping it"));
    });

    it("does not stall the queue when even the fresh view stays silent", async () => {
        const spare = makeView();
        const fresh = makeView();
        let settled = false;
        const result = acquireReadyView(
            () => spare,
            () => fresh,
            () => {},
            5000,
            15000
        ).then((r) => {
            settled = true;
            return r;
        });
        await vi.advanceTimersByTimeAsync(5000 + 15000);
        const rtn = await result;
        expect(settled).toBe(true);
        expect(rtn.ready).toBe(false);
        expect(rtn.view).toBe(fresh);
    });
});

describe("isDuplicateSwitch", () => {
    it("coalesces a repeated switch to the workspace the queue already ends with", () => {
        const queue = [{ op: "switchworkspace", workspaceId: "a" }];
        expect(isDuplicateSwitch(queue, "a")).toBe(true);
    });

    it("keeps a switch to another workspace, or after another kind of action", () => {
        expect(isDuplicateSwitch([], "a")).toBe(false);
        expect(isDuplicateSwitch([{ op: "switchworkspace", workspaceId: "a" }], "b")).toBe(false);
        expect(isDuplicateSwitch([{ op: "switchworkspace", workspaceId: "a" }, { op: "createtab" }], "a")).toBe(false);
    });

    it("coalesces seven clicks on the same workspace behind a slow switch", () => {
        const queue: { op: string; workspaceId?: string }[] = [{ op: "switchworkspace", workspaceId: "a" }];
        let queued = 0;
        for (let i = 0; i < 7; i++) {
            if (isDuplicateSwitch(queue, "b") === false) {
                queue.push({ op: "switchworkspace", workspaceId: "b" });
                queued++;
            }
        }
        expect(queued).toBe(1);
        expect(queue).toHaveLength(2);
    });
});
