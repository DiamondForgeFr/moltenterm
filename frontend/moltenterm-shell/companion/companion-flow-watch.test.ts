// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { FlowBlockSelector, FlowWatchEnv, watchFlow } from "./companion-flow-watch";

// The flow's element as the watch reads it: its blocks, which a section adds or drops with no render of the flow.
class FakeFlow {
    blocks: object[] = [];
    querySelectorAll(selector: string) {
        expect(selector).toBe(FlowBlockSelector);
        return this.blocks;
    }
}

function fakeEnv() {
    const resize: FakeResize[] = [];
    const mutation: FakeMutation[] = [];
    class FakeResize {
        callback: () => void;
        watched = new Set<object>();
        constructor(callback: () => void) {
            this.callback = callback;
            resize.push(this);
        }
        observe(el: object) {
            this.watched.add(el);
        }
        unobserve(el: object) {
            this.watched.delete(el);
        }
        disconnect() {
            this.watched.clear();
        }
    }
    class FakeMutation {
        callback: () => void;
        target: object = null;
        options: MutationObserverInit = null;
        constructor(callback: () => void) {
            this.callback = callback;
            mutation.push(this);
        }
        observe(target: object, options: MutationObserverInit) {
            this.target = target;
            this.options = options;
        }
        disconnect() {
            this.target = null;
        }
    }
    const env = { ResizeObserver: FakeResize, MutationObserver: FakeMutation } as unknown as FlowWatchEnv;
    return { env, resize, mutation };
}

function setup() {
    const flow = new FakeFlow();
    const companion = { companion: true };
    const fake = fakeEnv();
    let placed = 0;
    const watch = watchFlow(flow as unknown as HTMLElement, companion as unknown as Element, () => placed++, fake.env);
    return { flow, companion, watch, ro: fake.resize[0], mo: fake.mutation[0], placed: () => placed };
}

describe("what makes the flow place its blocks again (#2466)", () => {
    it("follows the companion's width and the size of every block it holds", () => {
        const { companion, ro, placed } = setup();
        expect(ro.watched.has(companion)).toBe(true);
        ro.callback();
        expect(placed()).toBe(1);
    });

    it("places and follows a block a section draws on its own, with no render of the flow", () => {
        const { flow, ro, mo, placed } = setup();
        const milestone = { id: "tasks" };
        flow.blocks.push(milestone);
        // The flow's own children only: a block's content changing is its size, which the resize observer follows.
        expect(mo.target).toBe(flow);
        expect(mo.options).toEqual({ childList: true });
        // The workspace task's read answers: its block appears in the flow, nothing renders the flow.
        const task = { id: "task" };
        flow.blocks.push(task);
        mo.callback();
        expect(placed()).toBe(1);
        expect(ro.watched.has(task)).toBe(true);
        expect(ro.watched.has(milestone)).toBe(true);
    });

    it("lets go of a block that leaves and places the others again", () => {
        const { flow, ro, mo, placed } = setup();
        const permission = { id: "permission" };
        const files = { id: "files" };
        flow.blocks.push(permission, files);
        mo.callback();
        flow.blocks = [files];
        mo.callback();
        expect(placed()).toBe(2);
        expect(ro.watched.has(permission)).toBe(false);
        expect(ro.watched.has(files)).toBe(true);
    });

    it("follows the new element of a block whose section swapped it", () => {
        const { flow, ro, mo } = setup();
        const loading = { id: "task" };
        flow.blocks.push(loading);
        mo.callback();
        const loaded = { id: "task" };
        flow.blocks = [loaded];
        mo.callback();
        expect(ro.watched.has(loading)).toBe(false);
        expect(ro.watched.has(loaded)).toBe(true);
    });

    it("observes nothing once stopped", () => {
        const { flow, ro, mo, watch } = setup();
        flow.blocks.push({ id: "files" });
        watch.sync();
        watch.stop();
        expect(ro.watched.size).toBe(0);
        expect(mo.target).toBe(null);
    });

    it("does nothing without a flow or without the observers (a window-less test)", () => {
        expect(() => watchFlow(null, null, () => {}).stop()).not.toThrow();
        expect(() => watchFlow(new FakeFlow() as unknown as HTMLElement, null, () => {}, null).sync()).not.toThrow();
    });
});
