// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import type { PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenModel } from "./screen-store";
import { ScreensAskedMetaKey, ScreenThresholdsMetaKey, type ScreenInfo } from "./screen-threshold";

const client = vi.hoisted(() => ({ atom: null as unknown }));

vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    client.atom = atom({ meta: {} });
    return { ClientModel: { getInstance: () => ({ clientAtom: client.atom, clientId: "client-1" }) } };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

const laptop: ScreenInfo = { key: "1512x982@2", widthpx: 1512, heightpx: 982, scalefactor: 2 };
const wide: ScreenInfo = { key: "3440x1440@1", widthpx: 3440, heightpx: 1440, scalefactor: 1 };

function setClientMeta(meta: Record<string, unknown>) {
    globalStore.set(client.atom as PrimitiveAtom<{ meta: Record<string, unknown> }>, { meta });
}

function metaWrites(): Record<string, unknown>[] {
    return vi.mocked(RpcApi.SetMetaCommand).mock.calls.map((c) => c[1].meta as Record<string, unknown>);
}

beforeEach(() => {
    vi.mocked(RpcApi.SetMetaCommand).mockClear();
    setClientMeta({});
    const model = ScreenModel.getInstance();
    globalStore.set(model.pendingAtom, null);
    globalStore.set(model.pendingAskedAtom, null);
    globalStore.set(model.screenAtom, laptop);
});

describe("the offer to save a screen (FR-SHELL-066-AC12, #2180)", () => {
    it("is made for a screen the Columns per screen list does not hold", () => {
        const model = ScreenModel.getInstance();
        expect(model.saveOffered()).toBe(true);
        expect(model.saveOffered(wide)).toBe(true);
        globalStore.set(model.screenAtom, null);
        expect(model.saveOffered()).toBe(false);
    });

    it("is not made for a screen the list holds: saved now, or kept from an earlier run", () => {
        const model = ScreenModel.getInstance();
        model.setThreshold(3, laptop);
        expect(model.saveOffered()).toBe(false);
        expect(model.saveOffered(wide)).toBe(true);
        globalStore.set(model.pendingAtom, null);
        setClientMeta({ [ScreenThresholdsMetaKey]: { [wide.key]: { columns: 4 } } });
        expect(model.saveOffered(wide)).toBe(false);
    });

    it("Not now is remembered for that screen, in the client's meta, and never asked again", () => {
        const model = ScreenModel.getInstance();
        model.decline(laptop);
        expect(model.saveOffered(laptop)).toBe(false);
        expect(model.saveOffered(wide)).toBe(true);
        expect(metaWrites()).toEqual([{ [ScreensAskedMetaKey]: { [laptop.key]: true } }]);
        expect(vi.mocked(RpcApi.SetMetaCommand).mock.calls[0][1].oref).toBe("client:client-1");
        // A later run reads it back from the meta.
        globalStore.set(model.pendingAskedAtom, null);
        setClientMeta({ [ScreensAskedMetaKey]: { [laptop.key]: true } });
        expect(model.saveOffered(laptop)).toBe(false);
        // A second screen is added to the first.
        model.decline(wide);
        expect(metaWrites().at(-1)).toEqual({ [ScreensAskedMetaKey]: { [laptop.key]: true, [wide.key]: true } });
    });

    it("saving shows the screen in the list with its threshold", () => {
        const model = ScreenModel.getInstance();
        model.setThreshold(3, laptop);
        expect(metaWrites()).toEqual([
            {
                [ScreenThresholdsMetaKey]: {
                    [laptop.key]: { columns: 3, widthpx: 1512, heightpx: 982, scalefactor: 2 },
                },
            },
        ]);
        expect(globalStore.get(model.storedAtom)[laptop.key].columns).toBe(3);
    });

    it("declining without a screen does nothing", () => {
        const model = ScreenModel.getInstance();
        model.decline(null);
        expect(metaWrites()).toEqual([]);
    });
});
