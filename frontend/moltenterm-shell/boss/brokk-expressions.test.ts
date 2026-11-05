// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("./boss-store", () => ({ BossBubbleModel: { getInstance: () => ({}) } }));

import { globalStore } from "@/app/store/jotaiStore";
import type { BrokkExpression } from "./brokk-ask-model";
import { BrokkExpressionsModel, watchCalls } from "./brokk-expressions";

describe("the call Brokk makes when the count of the badge rises (FR-BOSS-007, AC3)", () => {
    function listen(start: number) {
        const store = createStore();
        const cueAtom = atom(start) as PrimitiveAtom<number>;
        const asked: BrokkExpression[] = [];
        const stop = watchCalls(store, cueAtom, (expression) => asked.push(expression));
        return { store, cueAtom, asked, stop };
    }

    it("makes the call gesture when the count rises, and for no rise at the start", () => {
        const { store, cueAtom, asked } = listen(4);
        expect(asked).toEqual([]);
        store.set(cueAtom, 5);
        expect(asked).toEqual(["call"]);
        store.set(cueAtom, 6);
        expect(asked).toEqual(["call", "call"]);
    });

    it("stops listening when the bubble goes", () => {
        const { store, cueAtom, asked, stop } = listen(0);
        stop();
        store.set(cueAtom, 9);
        expect(asked).toEqual([]);
    });
});

describe("the gesture asked", () => {
    beforeEach(() => {
        BrokkExpressionsModel.resetInstance();
        globalStore.set(BrokkExpressionsModel.getInstance().askedAtom, null);
    });

    it("is none until one is asked, and each asking has a cue of its own, the same gesture twice included", () => {
        const model = BrokkExpressionsModel.getInstance();
        expect(globalStore.get(model.askedAtom)).toBeNull();
        model.ask("smile");
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile", cue: 1 });
        model.ask("smile");
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile", cue: 2 });
        model.ask("nod");
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "nod", cue: 3 });
    });

    it("keeps the gesture that tells why when the call is asked in the same moment", () => {
        const model = BrokkExpressionsModel.getInstance();
        model.ask("frown");
        const frown = globalStore.get(model.askedAtom);
        model.ask("call");
        expect(globalStore.get(model.askedAtom)).toBe(frown);
    });
});
