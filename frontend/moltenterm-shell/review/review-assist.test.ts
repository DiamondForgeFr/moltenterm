// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({ setMeta: vi.fn(async () => {}), tabAtom: null as any }));

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: Mocks.setMeta } }));
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getWaveObjectAtom: () => Mocks.tabAtom,
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import {
    readAssistRequest,
    requestAssist,
    ReviewAssistMaxAgeMs,
    ReviewAssistMetaKey,
    watchAssistRequests,
} from "./review-assist";
import { diffLayoutOf, shownRenderMs } from "./review-model";

describe("the assisted review's hand-off to the Review tab (FR-REV-033 AC2)", () => {
    it("is left in the tab's meta, which the Review tab's page reads", async () => {
        Mocks.setMeta.mockClear();
        await requestAssist("tab-1");
        const call = (Mocks.setMeta.mock.calls[0] as any[])[1];
        expect(call.oref).toBe("tab:tab-1");
        expect(typeof call.meta[ReviewAssistMetaKey].at).toBe("number");
    });

    it("honours a fresh ask only", () => {
        expect(readAssistRequest({ at: 1000 }, 1000 + ReviewAssistMaxAgeMs)).toEqual({ at: 1000 });
        expect(readAssistRequest({ at: 1000 }, 1001 + ReviewAssistMaxAgeMs)).toBeNull();
        expect(readAssistRequest(null, 1000)).toBeNull();
        expect(readAssistRequest({ at: "now" }, 1000)).toBeNull();
    });

    it("starts the agent once per ask and clears it", async () => {
        Mocks.setMeta.mockClear();
        Mocks.tabAtom = atom({ meta: {} }) as PrimitiveAtom<any>;
        const assist = vi.fn(async () => {});
        const stop = watchAssistRequests("tab-1", assist);
        expect(assist).not.toHaveBeenCalled();
        const ask = { at: Date.now() };
        globalStore.set(Mocks.tabAtom, { meta: { [ReviewAssistMetaKey]: ask } });
        globalStore.set(Mocks.tabAtom, { meta: { [ReviewAssistMetaKey]: ask, other: 1 } });
        await vi.waitFor(() => expect(assist).toHaveBeenCalledTimes(1));
        expect((Mocks.setMeta.mock.calls[0] as any[])[1].meta[ReviewAssistMetaKey]).toBeNull();
        stop();
    });
});

describe("a new file's diff (FR-REV-033 AC4)", () => {
    it("is one column, without the empty old side, whatever the toggle or the setting", () => {
        expect(diffLayoutOf("added", true, false)).toEqual({ sideBySide: false, trueInline: true });
        expect(diffLayoutOf("added", null, false)).toEqual({ sideBySide: false, trueInline: true });
    });

    it("leaves the other files to the toggle, then the setting", () => {
        expect(diffLayoutOf("modified", null, false)).toEqual({ sideBySide: true, trueInline: false });
        expect(diffLayoutOf("modified", false, false)).toEqual({ sideBySide: false, trueInline: false });
        expect(diffLayoutOf("deleted", null, true)).toEqual({ sideBySide: false, trueInline: false });
    });
});

describe("the diff's render time (FR-REV-033 AC4)", () => {
    it("shows in Developer mode only", () => {
        expect(shownRenderMs(425, true)).toBe(425);
        expect(shownRenderMs(425, false)).toBeNull();
    });
});
