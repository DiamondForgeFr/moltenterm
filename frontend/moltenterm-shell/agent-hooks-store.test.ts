// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHookOffer } from "./agent-hooks-model";

const rpc = vi.hoisted(() => ({
    calls: [] as { command: string; data: any }[],
    result: null as any,
    error: null as Error,
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: async (command: string, data: any) => {
            rpc.calls.push({ command, data });
            if (rpc.error) {
                throw rpc.error;
            }
            return rpc.result;
        },
    },
}));
vi.mock("./agent-state-store", () => ({
    AgentStates: { getInstance: () => ({ blockAtom: () => atom(() => null) }) },
}));

import { globalStore } from "@/app/store/jotaiStore";
import { AgentHookApplyCommand, AgentHookDismissCommand, AgentHookRemoveCommand } from "./agent-hooks-model";
import { AgentHookOffers } from "./agent-hooks-store";

function offer(fields: Partial<AgentHookOffer> = {}): AgentHookOffer {
    return {
        blockid: "block-kimi",
        agent: "kimi",
        agentname: "Kimi Code",
        show: true,
        persistent: true,
        status: "definition-update",
        action: "update",
        updatekind: "definition",
        updatekey: "reviewed-revision",
        configdigest: "reviewed-digest",
        canapply: true,
        canremove: true,
        ...fields,
    };
}

describe("persistent hook mutations in the shared store", () => {
    beforeEach(() => {
        rpc.calls = [];
        rpc.result = null;
        rpc.error = null;
    });

    it("submits exactly the reviewed action, digest and update key, never a client path", async () => {
        const store = AgentHookOffers.getInstance();
        const reviewed = offer();
        const refreshed = offer({ show: false, status: "reporting", action: "remove", updatekind: undefined });
        rpc.result = { offer: refreshed, backuppath: "/backups/config.toml.bak" };
        const result = await store.apply(reviewed);
        expect(rpc.calls).toEqual([
            {
                command: AgentHookApplyCommand,
                data: {
                    blockid: "block-kimi",
                    action: "update",
                    updatekey: "reviewed-revision",
                    expecteddigest: "reviewed-digest",
                },
            },
        ]);
        expect(rpc.calls[0].data).not.toHaveProperty("file");
        expect(rpc.calls[0].data).not.toHaveProperty("path");
        expect(result.backuppath).toBe("/backups/config.toml.bak");
        expect(globalStore.get(store.detailsAtom("block-kimi"))).toEqual(refreshed);
    });

    it("can remove from Integration details even when the proposal is hidden", async () => {
        const store = AgentHookOffers.getInstance();
        const reviewed = offer({ show: false, status: "compatibility-review", action: "review", canapply: false });
        const refreshed = offer({ status: "absent", action: "install", updatekind: undefined, canremove: false });
        rpc.result = { offer: refreshed };
        await store.remove(reviewed);
        expect(rpc.calls[0]).toEqual({
            command: AgentHookRemoveCommand,
            data: {
                blockid: "block-kimi",
                action: "remove",
                updatekey: "reviewed-revision",
                expecteddigest: "reviewed-digest",
            },
        });
        expect(globalStore.get(store.detailsAtom("block-kimi"))).toEqual(refreshed);
    });

    it("keeps the prior details after a stale or failed mutation", async () => {
        const store = AgentHookOffers.getInstance();
        const reviewed = offer();
        store.setOffer(reviewed.blockid, reviewed);
        rpc.error = new Error("stale Kimi hook approval");
        await expect(store.apply(reviewed)).rejects.toThrow("stale");
        expect(globalStore.get(store.detailsAtom(reviewed.blockid))).toEqual(reviewed);
    });

    it("dismisses only the reviewed update revision", async () => {
        const store = AgentHookOffers.getInstance();
        await store.dismiss("kimi", "reviewed-revision");
        expect(rpc.calls[0]).toEqual({
            command: AgentHookDismissCommand,
            data: { agent: "kimi", updatekey: "reviewed-revision" },
        });
    });
});
