// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom, PrimitiveAtom } from "jotai";
import { describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({ setMeta: vi.fn(async () => {}), tabAtom: null as any }));

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: Mocks.setMeta } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getWaveObjectAtom: () => Mocks.tabAtom,
}));

import { globalStore } from "@/app/store/jotaiStore";
import { readSheetRequest, ReviewSheetMaxAgeMs, ReviewSheetMetaKey, watchReviewSheetRequests } from "./review-sheet-request";

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
    Mocks.tabAtom = atom({ oid: "tab-r", meta: {} }) as PrimitiveAtom<any>;
    const stateAtom = atom(null) as PrimitiveAtom<any>;
    const model = { stateAtom, openPublish: vi.fn(async () => {}), openValidate: vi.fn(async () => {}) };
    return { model, stateAtom };
}

describe("review sheet request", () => {
    it("opens the requested sheet once the review store is read, then clears the request", async () => {
        const { model, stateAtom } = setup();
        Mocks.setMeta.mockClear();
        const stop = watchReviewSheetRequests("tab-r", model);
        globalStore.set(Mocks.tabAtom, { oid: "tab-r", meta: { [ReviewSheetMetaKey]: { id: "a", action: "merge", at: Date.now() } } });
        await flush();
        expect(model.openValidate).not.toHaveBeenCalled();
        globalStore.set(stateAtom, { comments: [] });
        await flush();
        expect(model.openValidate).toHaveBeenCalledTimes(1);
        expect(model.openPublish).not.toHaveBeenCalled();
        expect(Mocks.setMeta).toHaveBeenCalledWith({}, { oref: "tab:tab-r", meta: { [ReviewSheetMetaKey]: null } });
        globalStore.set(stateAtom, { comments: [1] });
        await flush();
        expect(model.openValidate).toHaveBeenCalledTimes(1);
        stop();
    });

    it("opens the Publish sheet for publish", async () => {
        const { model, stateAtom } = setup();
        globalStore.set(stateAtom, { comments: [] });
        globalStore.set(Mocks.tabAtom, { oid: "tab-r", meta: { [ReviewSheetMetaKey]: { id: "b", action: "publish", at: Date.now() } } });
        const stop = watchReviewSheetRequests("tab-r", model);
        await flush();
        expect(model.openPublish).toHaveBeenCalledTimes(1);
        stop();
    });

    it("ignores stale and malformed requests", () => {
        const now = 1_000_000_000;
        expect(readSheetRequest({ id: "a", action: "publish", at: now }, now)).not.toBeNull();
        expect(readSheetRequest({ id: "a", action: "publish", at: now - ReviewSheetMaxAgeMs - 1 }, now)).toBeNull();
        expect(readSheetRequest({ id: "a", action: "cleanup", at: now }, now)).toBeNull();
        expect(readSheetRequest({ action: "merge", at: now }, now)).toBeNull();
        expect(readSheetRequest(null, now)).toBeNull();
    });
});
