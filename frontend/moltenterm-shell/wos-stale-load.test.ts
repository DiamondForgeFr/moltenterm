// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({ answer: null as (() => void) | null, snapshot: null as any }));

vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://127.0.0.1:1" }));
vi.mock("@/util/fetchutil", () => ({
    fetch: () =>
        new Promise((resolve) => {
            const snapshot = app.snapshot;
            app.answer = () => resolve({ ok: true, json: () => Promise.resolve({ data: snapshot }) });
        }),
}));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/services", () => ({ ObjectService: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";

const Asked = "molten:settings:key";

function block(version: number, meta: Record<string, any>) {
    return { otype: "block", oid: "b1", version, meta } as any;
}

describe("a Wave object load that an update overtook (#1397)", () => {
    it("keeps the newer update when the older GetObject snapshot answers last", async () => {
        app.snapshot = block(1, { view: "waveconfig", [Asked]: "power:sleeppolicy" });
        const oref = WOS.makeORef("block", "b1");
        const atom = WOS.getWaveObjectAtom<Block>(oref);
        expect(globalStore.get(atom)).toBeNull();

        WOS.updateWaveObject({ updatetype: "update", otype: "block", oid: "b1", obj: block(3, { view: "waveconfig" }) });
        expect(globalStore.get(atom).meta[Asked]).toBeUndefined();

        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await vi.waitFor(() => expect(app.answer).not.toBeNull(), { timeout: 30000 });
        app.answer();
        await vi.waitFor(() => expect(log.mock.calls.some((c) => c[0] === "WaveObj resolved")).toBe(true), {
            timeout: 30000,
        });
        log.mockRestore();

        const shown = globalStore.get(atom);
        expect(shown.version).toBe(3);
        expect(shown.meta[Asked]).toBeUndefined();
    });
});
