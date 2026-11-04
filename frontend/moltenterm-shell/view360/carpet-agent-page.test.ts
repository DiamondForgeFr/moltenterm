// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAgentPageMeta, isAgentPagePanel } from "./carpet-agent-page";

const Store = vi.hoisted(() => ({
    cached: new Map<string, unknown>(),
    loaded: new Map<string, unknown>(),
    reload: null as ReturnType<typeof vi.fn>,
}));

vi.mock("@/app/store/wos", () => {
    Store.reload = vi.fn(async (oref: string) => Store.loaded.get(oref));
    return {
        makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
        getObjectValue: (oref: string) => Store.cached.get(oref),
        reloadWaveObject: Store.reload,
    };
});

const agentPanel = {
    meta: { view: "molten-browser", "molten:browser:tabs": [{ id: "agent-0f1c", url: "about:blank" }] },
};
const userPanel = {
    meta: { view: "molten-browser", "molten:browser:tabs": [{ id: "muxxpzvh-1", url: "https://example.com" }] },
};

beforeEach(() => {
    Store.cached.clear();
    Store.loaded.clear();
    Store.reload.mockClear();
});

describe("a page an agent shows (#1812)", () => {
    it("tells the panel of an agent's tab from a panel the developer opened", () => {
        expect(isAgentPageMeta(agentPanel.meta)).toBe(true);
        expect(isAgentPageMeta(userPanel.meta)).toBe(false);
    });

    it("is not a panel without tabs, a terminal or no block at all", () => {
        expect(isAgentPageMeta({ view: "term" })).toBe(false);
        expect(isAgentPageMeta({ "molten:browser:tabs": [] })).toBe(false);
        expect(isAgentPageMeta({ "molten:browser:tabs": "agent-x" })).toBe(false);
        expect(isAgentPageMeta(null)).toBe(false);
    });

    it("reads the block from the store when it has it", async () => {
        Store.cached.set("block:b1", agentPanel);
        expect(await isAgentPagePanel("b1")).toBe(true);
        expect(Store.reload).not.toHaveBeenCalled();
    });

    it("loads a block created a moment ago that the store does not have yet", async () => {
        Store.loaded.set("block:b2", agentPanel);
        expect(await isAgentPagePanel("b2")).toBe(true);
        expect(Store.reload).toHaveBeenCalledWith("block:b2");
        Store.loaded.set("block:b3", userPanel);
        expect(await isAgentPagePanel("b3")).toBe(false);
        expect(await isAgentPagePanel("")).toBe(false);
    });
});
