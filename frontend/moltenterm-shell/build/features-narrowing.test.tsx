// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
    clientId: "client-1" as string,
    known: true,
    atom: null as any,
    writes: [] as { oref: string; meta: any }[],
    release: (() => {}) as () => void,
    hold: false,
}));

vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    world.atom = atom({ meta: undefined as any });
    return {
        ClientModel: {
            getInstance: () => ({
                get clientId() {
                    return world.clientId;
                },
                get clientAtom() {
                    return world.known ? world.atom : undefined;
                },
            }),
        },
    };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (otype: string, oid: string) => `${otype}:${oid}` }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: async (_client: unknown, data: { oref: string; meta: any }) => {
            world.writes.push(data);
            if (world.hold) {
                await new Promise<void>((resolve) => {
                    world.release = resolve;
                });
            }
        },
    },
}));

import { currentNarrowing, narrowingToChange, useNarrowing, writeNarrowing } from "./features-narrowing";
import { FeaturesMetaKey, NoNarrowing, withFeatureOff, withPublicVersion } from "./gated-features";

beforeEach(() => {
    world.clientId = "client-1";
    world.known = true;
    world.writes.length = 0;
    world.hold = false;
    globalStore.set(world.atom, { meta: undefined });
});

// FR-BOSS-011 AC6, AC7: the switches are the client's meta, read from the client object in every window.
describe("the developer's switches in the client's meta", () => {
    it("narrow nothing before the client is known, or while none is stored", () => {
        world.known = false;
        expect(currentNarrowing()).toEqual(NoNarrowing);
        world.known = true;
        expect(currentNarrowing()).toEqual(NoNarrowing);
        globalStore.set(world.atom, { meta: { "molten:other": 1 } });
        expect(currentNarrowing()).toEqual(NoNarrowing);
    });

    it("are read at each call, so a switch applies at once", () => {
        globalStore.set(world.atom, { meta: { [FeaturesMetaKey]: { public: false, off: ["brainstorm"] } } });
        expect(currentNarrowing()).toEqual({ public: false, off: ["brainstorm"] });
        globalStore.set(world.atom, { meta: { [FeaturesMetaKey]: { public: true, off: [] } } });
        expect(currentNarrowing()).toEqual({ public: true, off: [] });
    });

    it("redraw a surface that shows a gate", () => {
        function Probe() {
            const narrowing = useNarrowing();
            return <i>{`${narrowing.public}:${narrowing.off.join(",")}`}</i>;
        }
        const html = () =>
            renderToStaticMarkup(
                <Provider store={globalStore}>
                    <Probe />
                </Provider>
            );
        expect(html()).toBe("<i>false:</i>");
        globalStore.set(world.atom, { meta: { [FeaturesMetaKey]: { public: true, off: ["brainstorm"] } } });
        expect(html()).toBe("<i>true:brainstorm</i>");
    });

    it("are written whole, under the meta key of the client object", async () => {
        await writeNarrowing({ public: true, off: ["brainstorm"] });
        expect(world.writes).toEqual([
            { oref: "client:client-1", meta: { [FeaturesMetaKey]: { public: true, off: ["brainstorm"] } } },
        ]);
    });

    it("write nothing before the client is known", async () => {
        world.clientId = null;
        await writeNarrowing({ public: true, off: [] });
        expect(world.writes).toEqual([]);
    });

    it("build a second switch on the first one that is still being written", async () => {
        world.hold = true;
        const first = writeNarrowing(withFeatureOff(narrowingToChange(), "brainstorm", true));
        expect(narrowingToChange()).toEqual({ public: false, off: ["brainstorm"] });
        const next = withPublicVersion(narrowingToChange(), true);
        expect(next).toEqual({ public: true, off: ["brainstorm"] });
        world.release();
        await first;
        expect(narrowingToChange()).toEqual(NoNarrowing);
    });
});
