// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the window does with the top row of the sidebar now that it belongs to the context (FR-SHELL-080, #2526): it
// shows the row of its workspace's context, pinning and unpinning write that row and no other, and a new context
// starts with a copy of the row of the context it was made from.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { wshRpcCall: vi.fn(async () => ({ tabid: "t-new" })) },
}));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: vi.fn(async () => {}),
        UpdateTabNameCommand: vi.fn(async () => {}),
        UpdateWorkspaceTabIdsCommand: vi.fn(async () => {}),
    },
}));
vi.mock("./sidebar-undo", async (orig) => ({
    ...(await orig<typeof import("./sidebar-undo")>()),
    showUndoToast: vi.fn(() => "toast-1"),
}));

import { ClientModel } from "@/app/store/client-model";
import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { ContextsMetaKey, WorkspaceContextMetaKey } from "../contexts/context-model";
import { pinTabWorkspace } from "../tab-workspace";
import { contextPinsKey } from "./context-pins-model";
import { startContextPins } from "./context-pins-store";
import { GlobalPin, GlobalPinMetaKey, viewStateOf } from "./view-pins-model";
import { ViewPins } from "./view-pins-store";

const ClientId = "c-pins";
const setMeta = vi.mocked(RpcApi.SetMetaCommand);

let version = 1;

function update(obj: WaveObj) {
    WOS.updateWaveObject({ updatetype: "update", otype: obj.otype, oid: obj.oid, obj });
}

function pin(id: string, name = id): GlobalPin {
    return { id, name, rev: 1, config: { tree: { pane: 0 }, panes: [{ view: "term", controller: "shell" }] } };
}

// The client and the workspaces as wavesrv would have echoed them.
function seed(rows: Record<string, GlobalPin[]>) {
    version++;
    const meta: Record<string, any> = {
        [ContextsMetaKey]: [{ id: "client" }, { id: "personal" }, { id: "fresh" }],
    };
    for (const [id, pins] of Object.entries(rows)) {
        meta[contextPinsKey(id)] = pins;
    }
    update({ otype: "client", oid: ClientId, version, meta } as unknown as Client);
    for (const [oid, context] of [
        ["ws-client", "client"],
        ["ws-client-2", "client"],
        ["ws-personal", "personal"],
        ["ws-fresh", "fresh"],
    ]) {
        update({
            otype: "workspace",
            oid,
            version,
            tabids: [],
            meta: { [WorkspaceContextMetaKey]: context },
        } as unknown as Workspace);
    }
}

function show(workspaceId: string) {
    pinTabWorkspace(workspaceId);
}

const ids = (pins: GlobalPin[]) => pins.map((p) => p.id);

// What the window wrote to the client meta, the keys it touched and each row.
function lastWrite(): Record<string, GlobalPin[]> {
    const call = setMeta.mock.calls.at(-1);
    return (call?.[1] as any)?.meta ?? null;
}

// The client as wavesrv echoes the write back.
function echo() {
    const written = lastWrite();
    version++;
    const client = WOS.getObjectValue<Client>(WOS.makeORef("client", ClientId));
    update({ ...client, version, meta: { ...client.meta, ...written } } as Client);
}

const config = { tree: { pane: 0 }, panes: [{ view: "molten-browser", url: "https://example.com" }] };

beforeAll(() => {
    initGlobalAtoms({ tabId: "t-1", windowId: "win-pins", clientId: ClientId, platform: "darwin" } as any);
    ClientModel.getInstance().initialize(ClientId);
    update({ otype: "window", oid: "win-pins", version: 1, workspaceid: "ws-client" } as WaveWindow);
});

beforeEach(() => {
    setMeta.mockClear();
    globalStore.set(ViewPins.getInstance().pendingPinsAtom, null);
    seed({
        client: [pin("g1", "Terminal"), pin("g2", "Lanceur")],
        personal: [pin("g3", "google.com")],
    });
    show("ws-client");
});

describe("two contexts show different tiles", () => {
    it("shows each workspace the row of its context", () => {
        const pins = ViewPins.getInstance();
        expect(pins.contextId()).toBe("client");
        expect(ids(pins.globalPins())).toEqual(["g1", "g2"]);
        show("ws-personal");
        expect(pins.contextId()).toBe("personal");
        expect(ids(pins.globalPins())).toEqual(["g3"]);
    });

    it("shows every workspace of a context the same row", () => {
        show("ws-client-2");
        expect(ids(ViewPins.getInstance().globalPins())).toEqual(["g1", "g2"]);
    });

    it("swaps the row at once when the window changes context, with no write", () => {
        const pins = ViewPins.getInstance();
        const shown: string[][] = [];
        const unsub = globalStore.sub(pins.globalPinsAtom, () => shown.push(ids(pins.globalPins())));
        show("ws-personal");
        show("ws-client");
        unsub();
        expect(shown).toEqual([["g3"], ["g1", "g2"]]);
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("shows a context that holds no row of its own an empty row", () => {
        show("ws-fresh");
        expect(ViewPins.getInstance().globalPins()).toEqual([]);
    });
});

describe("pin and unpin act on the current context only", () => {
    it("pins a view in the window's context and in no other", async () => {
        const pins = ViewPins.getInstance();
        await pins.createView({ config, scope: "everywhere", name: "Docs" });
        const written = lastWrite();
        expect(Object.keys(written)).toEqual([contextPinsKey("client")]);
        expect(written[contextPinsKey("client")].map((p) => p.name)).toEqual(["Terminal", "Lanceur", "Docs"]);
        echo();
        expect(pins.globalPins().map((p) => p.name)).toEqual(["Terminal", "Lanceur", "Docs"]);
        show("ws-personal");
        expect(pins.globalPins().map((p) => p.name)).toEqual(["google.com"]);
    });

    it("pins in the context of the workspace shown, whichever it is", async () => {
        show("ws-personal");
        await ViewPins.getInstance().createView({ config, scope: "everywhere", name: "Docs" });
        const written = lastWrite();
        expect(Object.keys(written)).toEqual([contextPinsKey("personal")]);
        expect(written[contextPinsKey("personal")].map((p) => p.name)).toEqual(["google.com", "Docs"]);
    });

    it("shows a pin at once in its context, before wavesrv echoes it, and not in the others", async () => {
        const pins = ViewPins.getInstance();
        let echoed: () => void = null;
        setMeta.mockImplementationOnce(() => new Promise<void>((resolve) => (echoed = resolve)));
        const writing = pins.createView({ config, scope: "everywhere", name: "Docs" });
        await vi.waitFor(() => expect(pins.globalPins().map((p) => p.name)).toContain("Docs"));
        show("ws-personal");
        expect(pins.globalPins().map((p) => p.name)).toEqual(["google.com"]);
        show("ws-client");
        echoed();
        await writing;
        expect(globalStore.get(pins.pendingPinsAtom)).toBeNull();
    });

    it("unpins a view from the window's context only, though another context pins the same one", async () => {
        seed({ client: [pin("g1", "Terminal"), pin("g2", "Lanceur")], personal: [pin("g1", "Terminal")] });
        await ViewPins.getInstance().unpinGlobal("g1");
        const written = lastWrite();
        expect(Object.keys(written)).toEqual([contextPinsKey("client")]);
        expect(ids(written[contextPinsKey("client")])).toEqual(["g2"]);
        echo();
        show("ws-personal");
        expect(ids(ViewPins.getInstance().globalPins())).toEqual(["g1"]);
    });

    it("reorders the row of the window's context only", async () => {
        await ViewPins.getInstance().reorderTop("g2", "g1", false);
        const written = lastWrite();
        expect(Object.keys(written)).toEqual([contextPinsKey("client")]);
        expect(ids(written[contextPinsKey("client")])).toEqual(["g2", "g1"]);
    });

    it("writes the first pin of a context that held no row as its row", async () => {
        show("ws-fresh");
        await ViewPins.getInstance().createView({ config, scope: "everywhere", name: "Docs" });
        const written = lastWrite();
        expect(Object.keys(written)).toEqual([contextPinsKey("fresh")]);
        expect(written[contextPinsKey("fresh")].map((p) => p.name)).toEqual(["Docs"]);
    });

    it("reads a tab pinned in one context as a plain view in a context whose row does not hold it", () => {
        const pins = ViewPins.getInstance();
        const tab = { meta: { [GlobalPinMetaKey]: "g1" } } as unknown as Tab;
        const stateIn = () => viewStateOf(tab, new Set(pins.globalPins().map((p) => p.id)));
        expect(stateIn()).toBe("everywhere");
        show("ws-personal");
        expect(stateIn()).toBe("temporary");
    });
});

describe("a new context gets its starting tiles", () => {
    it("starts with a copy of the row of the context it was made from", async () => {
        await startContextPins("fresh", "client");
        const written = lastWrite();
        expect(Object.keys(written)).toEqual([contextPinsKey("fresh")]);
        expect(ids(written[contextPinsKey("fresh")])).toEqual(["g1", "g2"]);
    });

    it("then changes on its own: pinning in the copy leaves the source as it is", async () => {
        await startContextPins("fresh", "client");
        echo();
        show("ws-fresh");
        await ViewPins.getInstance().createView({ config, scope: "everywhere", name: "Docs" });
        expect(ids(lastWrite()[contextPinsKey("fresh")])).toHaveLength(3);
        echo();
        show("ws-client");
        expect(ids(ViewPins.getInstance().globalPins())).toEqual(["g1", "g2"]);
    });

    it("writes the start once: a context that holds a row keeps it", async () => {
        await startContextPins("personal", "client");
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("does not make the creation fail when the start cannot be written", async () => {
        setMeta.mockRejectedValueOnce(new Error("offline"));
        await expect(startContextPins("fresh", "client")).resolves.toBeUndefined();
    });
});
