// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoltenHost, MoltenModStatus } from "../../molten/molten-host";
import { ModsRevokeModel } from "./settings-mods-model";

let model: ModsRevokeModel;
let revokeTrust: ReturnType<typeof vi.fn>;

beforeEach(() => {
    MoltenHost.resetInstance();
    ModsRevokeModel.resetInstance();
    model = ModsRevokeModel.getInstance();
    revokeTrust = vi.fn(async () => {});
    MoltenHost.getInstance().revokeTrust = revokeTrust as any;
});

afterEach(() => {
    MoltenHost.resetInstance();
    ModsRevokeModel.resetInstance();
});

describe("ModsRevokeModel", () => {
    it("starts idle for every mod", () => {
        expect(model.row("clock")).toEqual({ busy: false });
    });

    it("revokes the mod's trust and leaves the confirmation on its row", async () => {
        await model.revoke("clock");
        expect(revokeTrust).toHaveBeenCalledWith("clock");
        expect(model.row("clock")).toEqual({ busy: false, note: { kind: "done" } });
        expect(model.row("other")).toEqual({ busy: false });
    });

    it("is busy while the host works, and ignores a second click", async () => {
        let finish: () => void;
        revokeTrust.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));

        const first = model.revoke("clock");
        expect(model.row("clock").busy).toBe(true);
        await model.revoke("clock");
        expect(revokeTrust).toHaveBeenCalledTimes(1);

        finish();
        await first;
        expect(model.row("clock")).toEqual({ busy: false, note: { kind: "done" } });
    });

    it("keeps the reason when the host cannot revoke", async () => {
        revokeTrust.mockRejectedValue(new Error("/data/molten/trust.json is not valid JSON"));
        await model.revoke("clock");
        expect(model.row("clock")).toEqual({
            busy: false,
            note: { kind: "failed", message: "/data/molten/trust.json is not valid JSON" },
        });
    });

    it("takes what is not an error as its text", async () => {
        revokeTrust.mockRejectedValue("disk full");
        await model.revoke("clock");
        expect(model.row("clock").note).toEqual({ kind: "failed", message: "disk full" });
    });

    it("closes the confirmation, and a second revoke shows a new one", async () => {
        await model.revoke("clock");
        model.dismiss("clock");
        expect(model.row("clock")).toEqual({ busy: false });
        await model.revoke("clock");
        expect(model.row("clock").note).toEqual({ kind: "done" });
        expect(Object.keys(globalStore.get(model.rowsAtom))).toEqual(["clock"]);
    });

    it("drops the confirmation of a mod that is trusted again, so that it does not come back", async () => {
        const mod = (id: string, trusted: boolean): MoltenModStatus => ({
            id,
            path: `/cfg/mods/${id}`,
            state: "active",
            commands: [],
            trusted,
        });
        await model.revoke("clock");
        await model.revoke("idle");
        model.setRow("broken", { busy: false, note: { kind: "failed", message: "disk full" } });

        model.forgetOutdated([mod("clock", true), mod("idle", false), mod("broken", true)]);

        expect(model.row("clock")).toEqual({ busy: false });
        expect(model.row("idle").note).toEqual({ kind: "done" });
        expect(model.row("broken").note).toEqual({ kind: "failed", message: "disk full" });
    });

    it("leaves the rows alone when no mod needs it", async () => {
        await model.revoke("clock");
        const rows = globalStore.get(model.rowsAtom);
        model.forgetOutdated([
            { id: "clock", path: "/cfg/mods/clock", state: "disabled", commands: [], trusted: false },
        ]);
        expect(globalStore.get(model.rowsAtom)).toBe(rows);
    });

    it("asks the host that is current when it is clicked", async () => {
        MoltenHost.resetInstance();
        const later = vi.fn(async () => {});
        MoltenHost.getInstance().revokeTrust = later as any;
        await model.revoke("clock");
        expect(later).toHaveBeenCalledWith("clock");
        expect(revokeTrust).not.toHaveBeenCalled();
    });
});
