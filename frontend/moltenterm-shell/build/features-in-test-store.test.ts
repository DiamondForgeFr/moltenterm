// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
    log: [] as string[],
    state: null as any,
    stored: { public: false, off: [] as string[] },
    endFails: false,
}));

vi.mock("../brainstorm/brainstorm-boot", async () => {
    const { atom } = await import("jotai");
    world.state = atom(null);
    return {
        BrainstormStateAtom: world.state,
        loadBrainstorm: async () => {
            world.log.push("load");
            return {
                BrainstormModel: {
                    getInstance: () => ({
                        end: async () => {
                            world.log.push("end");
                            if (world.endFails) {
                                throw new Error("wavesrv did not answer");
                            }
                        },
                    }),
                },
            };
        },
    };
});
vi.mock("./features-narrowing", () => ({
    narrowingToChange: () => world.stored,
    writeNarrowing: async (next: { public: boolean; off: string[] }) => {
        world.log.push(`write ${JSON.stringify(next)}`);
        world.stored = next;
    },
}));

import { FeatureBrainstorm } from "./gated-features";
import { switchFeature, switchPublicVersion } from "./features-in-test-store";

beforeEach(() => {
    world.log.length = 0;
    world.stored = { public: false, off: [] };
    world.endFails = false;
    globalStore.set(world.state, null);
});

// FR-BOSS-011 AC3: a brainstorm open when its switch closes it is ended first, so what it held is let go; the state
// is written after.
describe("switching a feature", () => {
    it("ends the brainstorm that is open, then switches it off", async () => {
        globalStore.set(world.state, { open: true });
        await switchFeature(FeatureBrainstorm, true);
        expect(world.log).toEqual(["load", "end", 'write {"public":false,"off":["brainstorm"]}']);
    });

    it("loads and ends nothing when no brainstorm is open", async () => {
        globalStore.set(world.state, { open: false });
        await switchFeature(FeatureBrainstorm, true);
        expect(world.log).toEqual(['write {"public":false,"off":["brainstorm"]}']);
    });

    it("ends nothing when it turns a feature on", async () => {
        globalStore.set(world.state, { open: true });
        world.stored = { public: false, off: ["brainstorm"] };
        await switchFeature(FeatureBrainstorm, false);
        expect(world.log).toEqual(['write {"public":false,"off":[]}']);
    });

    it("switches the feature off even when the brainstorm could not be ended", async () => {
        globalStore.set(world.state, { open: true });
        world.endFails = true;
        await switchFeature(FeatureBrainstorm, true);
        expect(world.log.at(-1)).toBe('write {"public":false,"off":["brainstorm"]}');
    });
});

// FR-BOSS-011 AC4: the public version leaves each switch where it was.
describe("switching to the public version", () => {
    it("ends what is running, keeps the switches, and gives them back", async () => {
        globalStore.set(world.state, { open: true });
        world.stored = { public: false, off: ["brainstorm"] };
        await switchPublicVersion(true);
        expect(world.log).toEqual(["load", "end", 'write {"public":true,"off":["brainstorm"]}']);
        world.log.length = 0;
        await switchPublicVersion(false);
        expect(world.log).toEqual(['write {"public":false,"off":["brainstorm"]}']);
    });
});
