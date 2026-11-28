// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2589, FR-REV-036 AC10 and AC13: the first-time answer writes the confirmation wavesrv requires before the setting, and
// the notification's Stop is the same Stop as the block's.

import { beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
    calls: [] as { command: string; data: any }[],
    clientId: "client-1" as string | null,
    stop: null as any,
}));

vi.mock("@/app/store/client-model", () => ({
    ClientModel: { getInstance: () => ({ clientId: app.clientId }) },
}));
vi.mock("@/app/store/wos", () => ({ makeORef: (otype: string, oid: string) => `${otype}:${oid}` }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: async (_client: any, data: any) => {
            app.calls.push({ command: "meta", data });
        },
        SetConfigCommand: async (_client: any, data: any) => {
            app.calls.push({ command: "config", data });
        },
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../review/review-client", () => ({ stopSecurityFix: (req: any) => app.stop(req) }));

import { recordSecurityFixAnswer, securityFixStopGesture } from "./security-fix-actions";
import { SecurityFixStopGesture } from "./security-fix-model";

beforeEach(() => {
    app.calls = [];
    app.clientId = "client-1";
    app.stop = null;
});

describe("the developer's answer to the first-time ask (FR-REV-036 AC10)", () => {
    it("writes the confirmation in the client's meta first, then the setting, when he lets MoltenTerm start it on its own", async () => {
        await recordSecurityFixAnswer("always", 1234);
        expect(app.calls).toEqual([
            { command: "meta", data: { oref: "client:client-1", meta: { "molten:securityfix": 1234 } } },
            { command: "config", data: { "review:securityfix": true } },
        ]);
    });

    it("takes the confirmation back and writes false when he wants MoltenTerm to only offer it", async () => {
        await recordSecurityFixAnswer("ask", 1234);
        expect(app.calls).toEqual([
            { command: "meta", data: { oref: "client:client-1", meta: { "molten:securityfix": null } } },
            { command: "config", data: { "review:securityfix": false } },
        ]);
    });

    it("still writes the setting when the client is not known yet, which then counts as off without the confirmation", async () => {
        app.clientId = null;
        await recordSecurityFixAnswer("always", 1234);
        expect(app.calls).toEqual([{ command: "config", data: { "review:securityfix": true } }]);
    });
});

describe("the notification's Stop (FR-REV-036 AC13)", () => {
    it("is the gesture the notification of wavesrv names", () => {
        expect(SecurityFixStopGesture).toBe("review:securityfix:stop");
    });

    it("stops the fix its arguments name, and resolves the notification", async () => {
        const stop = vi.fn(async () => ({ status: "stopped" }));
        app.stop = stop;
        expect(await securityFixStopGesture({ dir: "/p", fingerprint: "0123456789abcdef" })).toEqual({
            ok: true,
            resolve: true,
        });
        expect(stop).toHaveBeenCalledWith({ dir: "/p", fingerprint: "0123456789abcdef" });
    });

    it("reports a fix that is not running, and never calls wavesrv on arguments it cannot read", async () => {
        const stop = vi.fn(async () => ({ status: "failed" }));
        app.stop = stop;
        const gone = await securityFixStopGesture({ dir: "/p", fingerprint: "0123456789abcdef" });
        expect(gone.ok).toBe(false);
        expect(gone.error).toMatch(/No security fix is running/);
        stop.mockClear();
        for (const args of [{}, { dir: "/p" }, { fingerprint: "x" }, { dir: 4, fingerprint: 5 }, undefined]) {
            expect((await securityFixStopGesture(args as any)).ok).toBe(false);
        }
        expect(stop).not.toHaveBeenCalled();
    });
});
