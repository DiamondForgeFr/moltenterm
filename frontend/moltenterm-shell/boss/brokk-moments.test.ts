// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));

// The listening is tested with stand-in sources below: the real models pull the whole app in. The merges the default
// source reads are an atom of this file's own.
const Sources = vi.hoisted(() => ({ merged: null as any }));
vi.mock("../reviews/reviews-store", async () => {
    const { atom } = await import("jotai");
    Sources.merged = atom({});
    return { ReviewsModel: { getInstance: () => ({ afterMergeAtom: Sources.merged }) } };
});
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    return {
        AgentStates: {
            getInstance: () => ({ dataAtom: atom({ states: {}, versions: {} }), loadedAtom: atom(false) }),
        },
    };
});
vi.mock("./developer-away", () => ({ InputEvents: [] }));
vi.mock("./boss-store", async () => {
    const { atom } = await import("jotai");
    return {
        BossBubbleModel: {
            getInstance: () => ({
                cueAtom: atom(0),
                cardOpenAtom: atom(false),
                toHandleAtom: atom({ items: [], info: [], parked: 0 }),
            }),
        },
    };
});

import { globalStore } from "@/app/store/jotaiStore";
import { BrokkExpressionsModel } from "./brokk-expressions";
import { mergedNumbers, startMoments, watchMerges } from "./brokk-moments";

describe("the pull requests that merged", () => {
    it("are told by their number, per project", () => {
        expect(mergedNumbers({ "/p": { merged: [1, 2] }, "/q": { merged: [1] }, "/r": {} })).toEqual(
            new Set(["/p#1", "/p#2", "/q#1"])
        );
        expect(mergedNumbers(null)).toEqual(new Set());
    });
});

describe("what makes Brokk smile while his portrait is on screen (FR-BOSS-007, AC3 and AC14)", () => {
    function listen(initial: Record<string, { merged?: number[] }> = {}) {
        const store = createStore();
        const mergedAtom = atom(initial) as PrimitiveAtom<Record<string, { merged?: number[] }>>;
        const told: number[] = [];
        const stop = watchMerges({ store, mergedAtom }, (number) => told.push(number));
        return { store, mergedAtom, told, stop };
    }

    it("tells a pull request that merges, not the ones merged before the portrait mounted", () => {
        const { store, mergedAtom, told } = listen({ "/p": { merged: [1] } });
        expect(told).toEqual([]);
        store.set(mergedAtom, { "/p": { merged: [1, 2] } });
        expect(told).toEqual([2]);
        store.set(mergedAtom, {});
        expect(told).toEqual([2]);
    });

    it("tells a number again for another project, and each new one once", () => {
        const { store, mergedAtom, told } = listen();
        store.set(mergedAtom, { "/p": { merged: [7] } });
        store.set(mergedAtom, { "/p": { merged: [7] }, "/q": { merged: [7] } });
        store.set(mergedAtom, { "/p": { merged: [7] }, "/q": { merged: [7] } });
        expect(told).toEqual([7, 7]);
    });

    it("stops listening when the portrait goes", () => {
        const { store, mergedAtom, told, stop } = listen();
        stop();
        store.set(mergedAtom, { "/p": { merged: [1] } });
        expect(told).toEqual([]);
    });
});

describe("one listening for every portrait on screen", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 10, 6, 10, 0, 0));
        BrokkExpressionsModel.resetInstance();
        globalStore.set(BrokkExpressionsModel.getInstance().askedAtom, null);
        globalStore.set(Sources.merged, {});
    });

    afterEach(() => {
        BrokkExpressionsModel.resetInstance();
        vi.useRealTimers();
    });

    it("smiles once when the bubble's screen and the card's header both show him, and tells the mood", () => {
        const model = BrokkExpressionsModel.getInstance();
        const first = startMoments();
        const second = startMoments();
        globalStore.set(Sources.merged, { "/p": { merged: [1] } });
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile", cue: 1 });
        expect(globalStore.get(model.moodAtom).news).toMatchObject({ kind: "merged", number: 1 });
        expect(globalStore.get(model.moodAtom).satisfiedAt).not.toBeNull();
        first();
        vi.advanceTimersByTime(61_000);
        globalStore.set(Sources.merged, { "/p": { merged: [1, 2] } });
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile", cue: 2 });
        second();
    });

    it("stops with the last portrait, and a stop told twice counts once", () => {
        const model = BrokkExpressionsModel.getInstance();
        const first = startMoments();
        const second = startMoments();
        first();
        first();
        globalStore.set(Sources.merged, { "/p": { merged: [1] } });
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile", cue: 1 });
        second();
        vi.advanceTimersByTime(61_000);
        globalStore.set(Sources.merged, { "/p": { merged: [1, 2] } });
        expect(globalStore.get(model.askedAtom)).toMatchObject({ cue: 1 });
    });

    it("starts again for a portrait that mounts later, from the facts of that moment", () => {
        const model = BrokkExpressionsModel.getInstance();
        startMoments()();
        globalStore.set(Sources.merged, { "/p": { merged: [1, 2, 3] } });
        const stop = startMoments();
        expect(globalStore.get(model.askedAtom)).toBeNull();
        globalStore.set(Sources.merged, { "/p": { merged: [1, 2, 3, 4] } });
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile" });
        stop();
    });
});
