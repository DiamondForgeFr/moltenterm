// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
    log: [] as string[],
    stored: { public: false, off: [] as string[] },
    running: false,
    endFails: false,
}));

// No feature is gated since the brainstorm shipped on every channel (#2320): the switches are proved on a sample one.
vi.mock("../../../pkg/molten/buildchannel/gated-features.json", () => ({
    default: {
        features: [
            {
                id: "sample",
                labelkey: "boss.brainstorm.menu",
                descriptionkey: "boss.brainstorm.opening",
                channels: ["dev", "local", "gold"],
                ticket: 1,
            },
        ],
    },
}));
vi.mock("./features-narrowing", () => ({
    narrowingToChange: () => world.stored,
    writeNarrowing: async (next: { public: boolean; off: string[] }) => {
        world.log.push(`write ${JSON.stringify(next)}`);
        world.stored = next;
    },
}));

import { EndBeforeOff, switchFeature, switchPublicVersion } from "./features-in-test-store";

beforeEach(() => {
    world.log.length = 0;
    world.stored = { public: false, off: [] };
    world.running = false;
    world.endFails = false;
    EndBeforeOff.sample = async () => {
        if (!world.running) {
            return;
        }
        world.log.push("end");
        if (world.endFails) {
            throw new Error("the feature did not answer");
        }
    };
});

// FR-BOSS-011 AC3: a feature that is running when its switch closes it is ended first, so what it held is let go; the
// state is written after.
describe("switching a feature", () => {
    it("ends the feature that is running, then switches it off", async () => {
        world.running = true;
        await switchFeature("sample", true);
        expect(world.log).toEqual(["end", 'write {"public":false,"off":["sample"]}']);
    });

    it("ends nothing when the feature is not running", async () => {
        await switchFeature("sample", true);
        expect(world.log).toEqual(['write {"public":false,"off":["sample"]}']);
    });

    it("ends nothing when it turns a feature on", async () => {
        world.running = true;
        world.stored = { public: false, off: ["sample"] };
        await switchFeature("sample", false);
        expect(world.log).toEqual(['write {"public":false,"off":[]}']);
    });

    it("switches the feature off even when it could not be ended", async () => {
        world.running = true;
        world.endFails = true;
        await switchFeature("sample", true);
        expect(world.log).toEqual(["end", 'write {"public":false,"off":["sample"]}']);
    });

    it("has nothing to end for a feature that holds nothing while it runs", async () => {
        delete EndBeforeOff.sample;
        await switchFeature("sample", true);
        expect(world.log).toEqual(['write {"public":false,"off":["sample"]}']);
    });

    it("keeps the brainstorm out of it: it has no switch since it ships on every channel", () => {
        expect(Object.keys(EndBeforeOff)).not.toContain("brainstorm");
    });
});

// FR-BOSS-011 AC4: the public version leaves each switch where it was.
describe("switching to the public version", () => {
    it("ends what is running, keeps the switches, and gives them back", async () => {
        world.running = true;
        world.stored = { public: false, off: ["sample"] };
        await switchPublicVersion(true);
        expect(world.log).toEqual(["end", 'write {"public":true,"off":["sample"]}']);
        world.log.length = 0;
        await switchPublicVersion(false);
        expect(world.log).toEqual(['write {"public":false,"off":["sample"]}']);
    });
});
