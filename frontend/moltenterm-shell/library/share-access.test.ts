// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { giveAccessBack, removeAccess } from "./share-access";
import type { SentRow } from "./library-model";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: rpc } }));

const row = (id: string, sessionId = "original"): SentRow =>
    ({ key: id, panelBlockId: "panel", browserTabId: id, sessionId, agentBlockId: "terminal" }) as SentRow;

beforeEach(() => {
    rpc.mockReset();
});

describe("shared page access", () => {
    it("removes only rows still held by their recorded session, including Remove all", async () => {
        rpc.mockImplementation(async (_command, req) => {
            if (req.browsertabid === "moved") throw new Error("holder changed");
        });
        const rows = [row("moved"), row("held")];
        expect(await removeAccess(rows)).toEqual([rows[1]]);
        expect(rpc.mock.calls.map((call) => call[1].expectedsessionid)).toEqual(["original", "original"]);
    });

    it("undo uses the original session even if a replacement uses the same terminal", async () => {
        rpc.mockImplementation(async (_command, req) => {
            if (req.sessionid === "original") throw new Error("session ended");
            return { result: "shared" };
        });
        expect(await giveAccessBack([row("page")])).toBe(1);
        expect(rpc).toHaveBeenCalledOnce();
        expect(rpc.mock.calls[0][1]).toMatchObject({ sessionid: "original", move: false });
    });

    it("undo succeeds for the original session after reconnect and refuses missing identities", async () => {
        rpc.mockResolvedValue({ result: "shared" });
        expect(await giveAccessBack([row("page"), row("unknown", "")])).toBe(1);
        expect(await removeAccess([row("unknown", "")])).toEqual([]);
        expect(rpc).toHaveBeenCalledOnce();
    });
});
