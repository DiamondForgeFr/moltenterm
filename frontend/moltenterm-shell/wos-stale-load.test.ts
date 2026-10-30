// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
    answer: null as (() => void) | null,
    answers: [] as (() => void)[],
    snapshot: null as any,
    fail: false,
}));

vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://127.0.0.1:1" }));
vi.mock("@/util/fetchutil", () => ({
    fetch: () =>
        new Promise((resolve) => {
            const snapshot = app.snapshot;
            const fail = app.fail;
            app.answer = () =>
                resolve(
                    fail
                        ? { ok: false, status: 500, statusText: "error" }
                        : { ok: true, json: () => Promise.resolve({ data: snapshot }) }
                );
            app.answers.push(app.answer);
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

        WOS.updateWaveObject({
            updatetype: "update",
            otype: "block",
            oid: "b1",
            obj: block(3, { view: "waveconfig" }),
        });
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

describe("loads overtaken by deletion and newer values (#1462)", () => {
    it("does not resurrect a deletion, and a later load can recreate the object", async () => {
        app.answer = null;
        app.snapshot = { ...block(1, {}), oid: "deleted" };
        const oref = "block:deleted";
        const pending = WOS.loadAndPinWaveObject<Block>(oref);
        await vi.waitFor(() => expect(app.answer).not.toBeNull());
        WOS.updateWaveObject({ updatetype: "delete", otype: "block", oid: "deleted" });
        app.answer();
        expect(await pending).toBeNull();
        expect(WOS.getObjectValue(oref)).toBeNull();
        app.answer = null;
        app.snapshot = { ...block(2, {}), oid: "deleted" };
        const later = WOS.reloadWaveObject<Block>(oref);
        await vi.waitFor(() => expect(app.answer).not.toBeNull());
        app.answer();
        expect((await later).version).toBe(2);
    });

    it("returns the newer cached update to a reload caller", async () => {
        const oref = "block:reload";
        app.answer = null;
        app.snapshot = { ...block(1, {}), oid: "reload" };
        const initial = WOS.loadAndPinWaveObject<Block>(oref);
        await vi.waitFor(() => expect(app.answer).not.toBeNull());
        app.answer();
        await initial;
        app.answer = null;
        app.snapshot = { ...block(2, {}), oid: "reload" };
        const pending = WOS.reloadWaveObject<Block>(oref);
        await vi.waitFor(() => expect(app.answer).not.toBeNull());
        WOS.updateWaveObject({
            updatetype: "update",
            otype: "block",
            oid: "reload",
            obj: { ...block(3, {}), oid: "reload" },
        });
        app.answer();
        expect((await pending).version).toBe(3);
        expect(WOS.getObjectValue<Block>(oref).version).toBe(3);
    });

    it("keeps a recreated object even when an older pre-delete snapshot has a higher version", async () => {
        app.answers = [];
        app.snapshot = { ...block(9, {}), oid: "recreated" };
        const pending = WOS.loadAndPinWaveObject<Block>("block:recreated");
        await vi.waitFor(() => expect(app.answers).toHaveLength(1));
        WOS.updateWaveObject({ updatetype: "delete", otype: "block", oid: "recreated" });
        WOS.updateWaveObject({
            updatetype: "update",
            otype: "block",
            oid: "recreated",
            obj: { ...block(1, {}), oid: "recreated" },
        });
        app.answers[0]();
        expect((await pending).version).toBe(1);
    });

    it("does not let an older null response erase a concurrent successful reload", async () => {
        app.answers = [];
        app.snapshot = null;
        const first = WOS.loadAndPinWaveObject<Block>("block:concurrent");
        await vi.waitFor(() => expect(app.answers).toHaveLength(1));
        app.snapshot = { ...block(2, {}), oid: "concurrent" };
        const second = WOS.reloadWaveObject<Block>("block:concurrent");
        await vi.waitFor(() => expect(app.answers).toHaveLength(2));
        app.answers[1]();
        expect((await second).version).toBe(2);
        app.answers[0]();
        expect((await first).version).toBe(2);
    });

    it("propagates a load failure and allows a subsequent reload", async () => {
        app.answer = null;
        app.fail = true;
        const first = WOS.loadAndPinWaveObject<Block>("block:failure");
        await vi.waitFor(() => expect(app.answer).not.toBeNull());
        app.answer();
        await expect(first).rejects.toThrow("500");
        app.fail = false;
        app.answer = null;
        app.snapshot = { ...block(1, {}), oid: "failure" };
        const retry = WOS.reloadWaveObject<Block>("block:failure");
        await vi.waitFor(() => expect(app.answer).not.toBeNull());
        app.answer();
        expect((await retry).version).toBe(1);
    });
});
