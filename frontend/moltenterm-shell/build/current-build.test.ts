// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
    isDev: false,
    runtimeChannel: "",
    narrowing: { public: false, off: [] as string[] },
}));

vi.mock("@/app/store/global", () => ({
    getApi: () => ({
        getIsDev: () => world.isDev,
        getEnv: (name: string) => (name === "MOLTENTERM_CHANNEL" ? world.runtimeChannel : ""),
    }),
}));
vi.mock("./features-narrowing", () => ({ currentNarrowing: () => world.narrowing }));

// The module graph loads once while the file is collected; each test then takes a fresh copy, since the channel is read
// once per copy.
import "./current-build";

type Build = typeof import("./current-build");

async function build(): Promise<Build> {
    vi.resetModules();
    return await import("./current-build");
}

beforeEach(() => {
    world.isDev = false;
    world.runtimeChannel = "";
    world.narrowing = { public: false, off: [] };
});

// FR-BOSS-011 AC3, AC4, AC5: the window's gate is the channel's answer, narrowed by the developer's switches at each call.
describe("the window's gate of the brainstorm", () => {
    it("is open on a dev build, and closes with the switch, the public version, then opens again", async () => {
        world.isDev = true;
        const current = await build();
        expect(current.currentBrainstormAllowed()).toBe(true);
        expect(current.currentBrainstormGates()).toEqual({ start: true, replay: true });

        world.narrowing = { public: false, off: ["brainstorm"] };
        expect(current.currentBrainstormAllowed()).toBe(false);
        expect(current.currentBrainstormGates()).toEqual({ start: false, replay: false });

        world.narrowing = { public: true, off: [] };
        expect(current.currentFeatureOn("brainstorm")).toBe(false);

        world.narrowing = { public: false, off: ["another"] };
        expect(current.currentBrainstormGates()).toEqual({ start: true, replay: true });
    });

    it("never opens on a release launched as a release, whatever is stored", async () => {
        for (const runtimeChannel of ["public", "rc"]) {
            world.runtimeChannel = runtimeChannel;
            for (const narrowing of [
                { public: false, off: [] },
                { public: false, off: ["brainstorm"] },
                { public: true, off: [] },
            ]) {
                world.narrowing = narrowing;
                const current = await build();
                expect(current.currentBrainstormAllowed(), `${runtimeChannel} ${JSON.stringify(narrowing)}`).toBe(false);
                expect(current.currentBrainstormGates()).toEqual({ start: false, replay: false });
            }
        }
    });

    it("keeps its scripted replay to dev and local builds, and takes it away with the brainstorm", async () => {
        world.isDev = true;
        const dev = await build();
        world.narrowing = { public: false, off: ["brainstorm"] };
        expect(dev.currentBrainstormGates().replay).toBe(false);
        world.isDev = false;
        world.runtimeChannel = "gold";
        world.narrowing = { public: false, off: [] };
        const gold = await build();
        expect(gold.currentBrainstormGates().replay).toBe(false);
    });
});
