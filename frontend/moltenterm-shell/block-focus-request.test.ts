// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { BlockFocusRequest, requestOnFocusChange, stepFocusRequest } from "./block-focus-request";

// React's limit before error #185 (maximum update depth): nested updates from layout effects.
const NestedUpdateLimit = 50;

type SimBlock = {
    id: string;
    request: BlockFocusRequest;
    queued: BlockFocusRequest[];
    prevFocused: boolean;
    prevRequest: BlockFocusRequest;
    mounted: boolean;
    applied: boolean[];
};

// Replays useBlockFocusRequest's two layout effects the way React runs them: each commit renders every block with its
// queued state and the layout's focus, then runs, block after block, the first effect when the block's focus changed
// and the second when its request or its focus changed. Updates made by the effects render in the next commit, which
// React performs synchronously, so the commits a change starts must settle under React's nested update limit.
class FocusSim {
    focused: string = null;
    blocks: SimBlock[];

    constructor(ids: string[]) {
        this.blocks = ids.map((id) => ({
            id,
            request: null,
            queued: [],
            prevFocused: false,
            prevRequest: null,
            mounted: false,
            applied: [],
        }));
    }

    block(id: string): SimBlock {
        return this.blocks.find((b) => b.id === id);
    }

    click(id: string) {
        this.block(id).queued.push("click");
    }

    private dirty(): boolean {
        return this.blocks.some((b) => {
            const next = b.queued.length > 0 ? b.queued[b.queued.length - 1] : b.request;
            return !b.mounted || next !== b.request || (this.focused === b.id) !== b.prevFocused;
        });
    }

    // Runs commits until nothing changes; returns how many it took.
    settle(): number {
        let commits = 0;
        while (this.dirty()) {
            commits++;
            if (commits > NestedUpdateLimit) {
                throw new Error("Maximum update depth exceeded (React error #185)");
            }
            const rendered = this.blocks.map((b) => {
                if (b.queued.length > 0) {
                    b.request = b.queued[b.queued.length - 1];
                    b.queued = [];
                }
                return { b, isFocused: this.focused === b.id, request: b.request };
            });
            for (const { b, isFocused, request } of rendered) {
                const focusChanged = !b.mounted || isFocused !== b.prevFocused;
                if (focusChanged) {
                    b.queued.push(requestOnFocusChange(isFocused));
                }
                if ((focusChanged || request !== b.prevRequest) && request != null) {
                    b.queued.push(null);
                    const step = stepFocusRequest(request, isFocused);
                    if (step?.apply) {
                        b.applied.push(step.takeLayoutFocus);
                        if (step.takeLayoutFocus) {
                            this.focused = b.id;
                        }
                    }
                }
                b.mounted = true;
                b.prevFocused = isFocused;
                b.prevRequest = request;
            }
        }
        return commits;
    }
}

describe("a block's focus request (#1750)", () => {
    it("settles when a block is clicked while the layout focuses another one in the same commit", () => {
        const sim = new FocusSim(["term", "browser", "companion"]);
        sim.focused = "companion";
        sim.settle();
        // The 1.0.0-6 gold blanked the view here: the two blocks took the focus back from each other forever.
        sim.focused = "term";
        sim.click("browser");
        expect(() => sim.settle()).not.toThrow();
        expect(sim.focused).toBe("browser");
    });

    it("gives the clicked block the layout's focus and the keyboard", () => {
        const sim = new FocusSim(["term", "browser"]);
        sim.focused = "term";
        sim.settle();
        sim.click("browser");
        sim.settle();
        expect(sim.focused).toBe("browser");
        expect(sim.block("browser").applied).toContain(true);
    });

    it("gives the keyboard to a block the layout focuses, without asking the layout again", () => {
        const sim = new FocusSim(["term", "browser"]);
        sim.focused = "term";
        sim.settle();
        sim.block("browser").applied = [];
        sim.focused = "browser";
        sim.settle();
        expect(sim.block("browser").applied).toEqual([false]);
    });

    it("never takes back a focus that moved on before the block took the keyboard", () => {
        expect(stepFocusRequest("focused", false)).toBeNull();
        expect(stepFocusRequest("focused", true)).toEqual({ apply: true, takeLayoutFocus: false });
        expect(stepFocusRequest("click", false)).toEqual({ apply: true, takeLayoutFocus: true });
        expect(stepFocusRequest(null, true)).toBeNull();
    });
});
