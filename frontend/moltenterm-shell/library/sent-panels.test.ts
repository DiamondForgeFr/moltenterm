// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { readSentPanels } from "./sent-panels";
import { makeSentRefresh } from "./sent-refresh";
import { sentToAiRows } from "./library-model";
import { removeAccess } from "./share-access";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), reload: vi.fn() }));
vi.mock("@/app/store/wos", () => ({ makeORef: (type: string, id: string) => `${type}:${id}`, reloadWaveObject: mocks.reload }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: mocks.rpc } }));
vi.mock("../browser/browser-model", () => ({ MoltentermBrowserView: "browser", readBrowserState: () => ({ tabs: [{ id: "page", url: "https://example.test" }] }) }));

it("does not resurrect access read before Remove while a later panel is slow", async () => {
    const objects: Record<string, unknown> = {
        "workspace:w": { tabids: ["t"] }, "tab:t": { blockids: ["a", "b"] },
        "block:a": { meta: { view: "browser" } }, "block:b": { meta: { view: "browser" } },
    };
    mocks.reload.mockImplementation(async (key) => objects[key]);
    let shared = true;
    let release: (value: unknown) => void;
    const slow = new Promise((resolve) => { release = resolve; });
    let blocked = false;
    mocks.rpc.mockImplementation(async (_command, data) => {
        if (data.action === "stop") { shared = false; return; }
        if (data.blockid === "a") return { tabs: shared ? [{ browsertabid: "page", sessionid: "session", agentblockid: "agent", origin: "shared", state: "active" }] : [] };
        if (!blocked) { blocked = true; return slow; }
        return { tabs: [] };
    });
    const refresh = makeSentRefresh<ReturnType<typeof sentToAiRows>>();
    const publish = vi.fn();
    const close = refresh.activate(
        async (current) => sentToAiRows(await readSentPanels([{ id: "w" } as any], current)),
        publish,
        (error) => { throw error; }
    );
    await vi.waitFor(() => expect(blocked).toBe(true));
    const removed = await refresh.mutate(() => removeAccess([{ key: "a:page", panelBlockId: "a", browserTabId: "page", sessionId: "session" } as any]));
    expect(removed).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
    release({ tabs: [] });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith([]));
    expect(publish).toHaveBeenCalledOnce();
    close();
});

it("does not continue traversal after its section is closed", async () => {
    let release: (value: unknown) => void;
    const loading = new Promise((resolve) => { release = resolve; });
    mocks.reload.mockReset().mockReturnValue(loading);
    mocks.rpc.mockReset();
    const refresh = makeSentRefresh<ReturnType<typeof sentToAiRows>>();
    const publish = vi.fn();
    const close = refresh.activate(
        async (current) => sentToAiRows(await readSentPanels([{ id: "w" } as any], current)),
        publish,
        vi.fn()
    );
    close();
    release({ tabids: ["t"] });
    await loading;
    await vi.waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
});
