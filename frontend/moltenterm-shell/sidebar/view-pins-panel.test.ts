// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the pins store does for a view made from a panel (FR-SHELL-080, #2548): a pin that lands where it was dropped,
// a tab made for a project, the exact copy a view shows against the configuration a pin keeps, a panel moved in, and the
// order of the workspace's tabs.

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
        EventSubCommand: vi.fn(async () => {}),
    },
}));
vi.mock("./sidebar-undo", async (orig) => ({
    ...(await orig<typeof import("./sidebar-undo")>()),
    showUndoToast: vi.fn(() => "toast-1"),
}));

import { ClientModel } from "@/app/store/client-model";
import { initGlobalAtoms } from "@/app/store/global-atoms";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { ContextsMetaKey, WorkspaceContextMetaKey } from "../contexts/context-model";
import { pinTabWorkspace } from "../tab-workspace";
import { contextPinsKey } from "./context-pins-model";
import {
    GlobalPin,
    GlobalPinMetaKey,
    insertPin,
    PinConfig,
    PinMetaKey,
    ViewPinBuildCommand,
    ViewPinCaptureCommand,
    ViewProjectHintMetaKey,
} from "./view-pins-model";
import { ViewPins } from "./view-pins-store";

const ClientId = "c-panel";
const call = vi.mocked(TabRpcClient.wshRpcCall);
const setMeta = vi.mocked(RpcApi.SetMetaCommand);
const reorder = vi.mocked(RpcApi.UpdateWorkspaceTabIdsCommand);

let version = 1;

function update(obj: WaveObj) {
    WOS.updateWaveObject({ updatetype: "update", otype: obj.otype, oid: obj.oid, obj });
}

function pin(id: string): GlobalPin {
    return { id, name: id, rev: 1, config: { tree: { pane: 0 }, panes: [{ view: "term", controller: "shell" }] } };
}

function seed(tabids: string[]) {
    version++;
    update({
        otype: "client",
        oid: ClientId,
        version,
        meta: { [ContextsMetaKey]: [{ id: "client" }], [contextPinsKey("client")]: [pin("g1"), pin("g2")] },
    } as unknown as Client);
    update({
        otype: "workspace",
        oid: "ws-panel",
        version,
        tabids,
        meta: { [WorkspaceContextMetaKey]: "client" },
    } as unknown as Workspace);
}

const pinned: PinConfig = { tree: { pane: 0 }, panes: [{ view: "molten-browser", url: "molten:repo/pulls" }] };
const exact: PinConfig = { tree: { pane: 0 }, panes: [{ view: "molten-browser", url: "https://example.com/a" }] };

function builds() {
    return call.mock.calls.filter((c) => c[0] === ViewPinBuildCommand).map((c) => c[1] as any);
}

beforeAll(() => {
    initGlobalAtoms({ tabId: "t-1", windowId: "win-panel", clientId: ClientId, platform: "darwin" } as any);
    ClientModel.getInstance().initialize(ClientId);
    update({ otype: "window", oid: "win-panel", version: 1, workspaceid: "ws-panel" } as WaveWindow);
});

beforeEach(() => {
    call.mockClear();
    setMeta.mockClear();
    reorder.mockClear();
    seed(["a", "b", "c", "t-new"]);
    pinTabWorkspace("ws-panel");
});

describe("a pin made from a panel lands where it was dropped", () => {
    it("is inserted before the pin named, or last", () => {
        const row = [pin("g1"), pin("g2"), pin("g3")];
        expect(insertPin(row, pin("n"), "g2").map((p) => p.id)).toEqual(["g1", "n", "g2", "g3"]);
        expect(insertPin(row, pin("n"), "g1").map((p) => p.id)).toEqual(["n", "g1", "g2", "g3"]);
        expect(insertPin(row, pin("n")).map((p) => p.id)).toEqual(["g1", "g2", "g3", "n"]);
        expect(insertPin(row, pin("n"), "gone").map((p) => p.id)).toEqual(["g1", "g2", "g3", "n"]);
    });

    it("writes the row of the window's context with the new pin before the one it was dropped before", async () => {
        await ViewPins.getInstance().createView({
            config: pinned,
            scope: "everywhere",
            name: "Docs",
            beforePinId: "g2",
        });
        const row = (setMeta.mock.calls.at(-1)?.[1] as any).meta[contextPinsKey("client")] as GlobalPin[];
        expect(row.map((p) => p.name)).toEqual(["g1", "Docs", "g2"]);
    });
});

describe("the view this workspace shows", () => {
    it("is made from the exact copy, while the pin keeps what a pin keeps", async () => {
        await ViewPins.getInstance().createView({
            config: pinned,
            instanceConfig: exact,
            scope: "everywhere",
            name: "Docs",
            background: true,
        });
        const row = (setMeta.mock.calls.at(-1)?.[1] as any).meta[contextPinsKey("client")] as GlobalPin[];
        expect(row.at(-1).config).toBe(pinned);
        const [build] = builds();
        expect(build.config).toBe(exact);
        expect(build.background).toBe(true);
        expect(build.tabmeta[GlobalPinMetaKey]).toBe(row.at(-1).id);
    });

    it("keeps a tile's configuration in the tab, and shows the exact copy", async () => {
        await ViewPins.getInstance().createView({
            config: pinned,
            instanceConfig: exact,
            scope: "workspace",
            name: "Docs",
            background: true,
        });
        const [build] = builds();
        expect(build.tabmeta[PinMetaKey]).toBe("workspace");
        expect(build.config).toBe(exact);
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("is made from its configuration when no copy is given, as before", async () => {
        await ViewPins.getInstance().createView({ config: pinned, scope: "workspace", name: "Docs" });
        expect(builds()[0].config).toBe(pinned);
        expect(builds()[0].adoptblockid).toBeUndefined();
    });

    it("is made for the project named, which wavesrv stamps on the tab", async () => {
        await ViewPins.getInstance().createView({ config: exact, scope: "temporary", name: "Docs", projectId: "p2" });
        expect(builds()[0].tabmeta[ViewProjectHintMetaKey]).toBe("p2");
        await ViewPins.getInstance().createView({ config: exact, scope: "temporary", name: "Docs" });
        expect(builds()[1].tabmeta[ViewProjectHintMetaKey]).toBeUndefined();
    });

    it("takes a panel that exists in place of a new one when it is moved in", async () => {
        await ViewPins.getInstance().createView({
            config: exact,
            scope: "temporary",
            name: "Agent",
            adopt: { blockid: "b-agent", fromtabid: "t-1" },
        });
        expect(builds()[0].adoptblockid).toBe("b-agent");
        expect(builds()[0].adoptfromtabid).toBe("t-1");
    });
});

describe("reading one panel to make a view of it", () => {
    it("asks wavesrv for that panel alone, as a copy or as a pin reads it", async () => {
        await ViewPins.getInstance().capturePanel("t-1", "b-1", true);
        await ViewPins.getInstance().capturePanel("t-1", "b-1", false);
        const captures = call.mock.calls.filter((c) => c[0] === ViewPinCaptureCommand).map((c) => c[1] as any);
        expect(captures).toHaveLength(2);
        for (const c of captures) {
            expect(c.tabid).toBe("t-1");
            expect(c.tree).toEqual({ blockid: "b-1" });
        }
        expect(captures.map((c) => c.copy)).toEqual([true, false]);
    });
});

describe("the order of the workspace's tabs", () => {
    it("places a new tab before the tab named", async () => {
        await ViewPins.getInstance().placeBefore("t-new", "b");
        expect(reorder.mock.calls.at(-1)[2]).toEqual(["a", "t-new", "b", "c"]);
    });

    it("leaves a new tab at the end when no tab is named", async () => {
        await ViewPins.getInstance().placeBefore("t-new", null);
        expect(reorder).not.toHaveBeenCalled();
    });

    it("changes nothing when the tab is already before the one named", async () => {
        seed(["a", "t-new", "b", "c"]);
        await ViewPins.getInstance().placeBefore("t-new", "b");
        expect(reorder).not.toHaveBeenCalled();
    });
});
