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

// FR-BOSS-010 AC1 (#2320): the window's gate of the brainstorm is the channel alone, a release candidate and a public
// release included. FR-BOSS-011 AC3 to AC5: the gate of a gated feature is the channel's answer, narrowed by the
// developer's switches at each call.
describe("the window's gate of the brainstorm", () => {
    it("is open on a dev build, with its scripted replay", async () => {
        world.isDev = true;
        const current = await build();
        expect(current.currentBrainstormAllowed()).toBe(true);
        expect(current.currentBrainstormGates()).toEqual({ start: true, replay: true });
    });

    it("is open on a release candidate and a public release, without the replay, whatever is stored", async () => {
        for (const runtimeChannel of ["public", "rc"]) {
            world.runtimeChannel = runtimeChannel;
            for (const narrowing of [
                { public: false, off: [] },
                { public: false, off: ["brainstorm"] },
                { public: true, off: [] },
            ]) {
                world.narrowing = narrowing;
                const current = await build();
                expect(current.currentBrainstormAllowed(), `${runtimeChannel} ${JSON.stringify(narrowing)}`).toBe(true);
                expect(current.currentBrainstormGates()).toEqual({ start: true, replay: false });
            }
        }
    });

    it("ignores what Features in test stored on a gold, and keeps the replay to dev and local builds", async () => {
        world.runtimeChannel = "gold";
        world.narrowing = { public: true, off: ["brainstorm"] };
        const gold = await build();
        expect(gold.currentBrainstormGates()).toEqual({ start: true, replay: false });
        world.isDev = true;
        world.runtimeChannel = "";
        const dev = await build();
        expect(dev.currentBrainstormGates()).toEqual({ start: true, replay: true });
    });

    it("opens nothing for a gated feature the registry does not list", async () => {
        world.isDev = true;
        const current = await build();
        expect(current.currentFeatureOn("brainstorm")).toBe(false);
        expect(current.currentFeatureOn("another")).toBe(false);
    });
});
