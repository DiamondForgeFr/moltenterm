// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the view states do (FR-SHELL-080): pinning in the workspace or everywhere, unpinning, saving a changed pinned
// view or bringing it back, closing the finished temporary views and starting an agent in a slot. Loaded on the first
// such action (view-pins-store.ts), so this code stays out of the JS every tab view loads up front (NFR-PERF-003,
// bundle.initialJsMB). wavesrv reads and makes the views (pkg/molten/viewpin).

import { ClientModel } from "@/app/store/client-model";
import { atoms, getApi, globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { AgentStates } from "../agent-state-store";
import { fetchCodingAgent } from "../coding-agent/coding-agent";
import { t, tCount } from "../i18n/i18n";
import { pipelineAgentOf } from "../mission/pipeline-agent";
import { typeCommandWhenReady } from "../palette/palette-actions";
import { recordingTabClose, reopenLastQuietly } from "../reopen/reopen-store";
import { showToast } from "../toast-store";
import { readWorkspaceProject } from "../workspace-project";
import {
    agentBlocksOf,
    AgentSlotMetaKey,
    GlobalPin,
    GlobalPinMetaKey,
    GlobalPinRevMetaKey,
    GlobalPinsMetaKey,
    instanceStale,
    layoutTree,
    makeGlobalPinId,
    PinConfig,
    PinConfigMetaKey,
    PinMetaKey,
    PinNode,
    PinWorkspace,
    readPinConfig,
    replacePin,
    UnpinnedTabMeta,
    viewBusy,
    ViewPinBuildCommand,
    ViewPinCaptureCommand,
    ViewPinRoute,
    withoutPin,
} from "./view-pins-model";
import { ClosedFinishedMetaKey, tabAtom, type ViewPins } from "./view-pins-store";

const CaptureTimeoutMs = 10000;
const BuildTimeoutMs = 15000;
const ClosedToastMs = 15000;
const WaitSteps = 50;
const WaitStepMs = 100;

function pinError(e: any) {
    showToast({ kind: "error", title: t("sidebar.pins.failed"), message: String(e?.message ?? e) });
}

function writeGlobalPins(pins: ViewPins, next: GlobalPin[]): Promise<void> {
    const clientId = ClientModel.getInstance().clientId;
    globalStore.set(pins.pendingPinsAtom, next);
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("client", clientId),
        meta: { [GlobalPinsMetaKey]: next } as MetaType,
    }).finally(() => {
        if (globalStore.get(pins.pendingPinsAtom) === next) {
            globalStore.set(pins.pendingPinsAtom, null);
        }
    });
}

function setTabMeta(tabId: string, meta: Record<string, any>): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, { oref: WOS.makeORef("tab", tabId), meta: meta as MetaType });
}

// The view's layout as the window shows it: the live tree for the tab on screen (the stored one lags behind).
function treeOf(tabId: string): PinNode {
    if (tabId === globalStore.get(atoms.staticTabId)) {
        const live = getLayoutModelForStaticTab()?.treeState?.rootNode;
        if (live != null) {
            return layoutTree(live);
        }
    }
    const tab = globalStore.get(tabAtom(tabId));
    const layout = globalStore.get(WOS.getWaveObjectAtom<LayoutState>(WOS.makeORef("layout", tab?.layoutstate)));
    return layoutTree(layout?.rootnode);
}

function capture(tabId: string): Promise<PinConfig> {
    const tab = globalStore.get(tabAtom(tabId));
    const data = globalStore.get(AgentStates.getInstance().dataAtom);
    return TabRpcClient.wshRpcCall(
        ViewPinCaptureCommand,
        {
            workspaceid: globalStore.get(atoms.workspaceId),
            tabid: tabId,
            tree: treeOf(tabId),
            agentblocks: agentBlocksOf(data, tab?.blockids ?? []),
        },
        { route: ViewPinRoute, timeout: CaptureTimeoutMs }
    );
}

function build(req: {
    tabid?: string;
    name?: string;
    tabmeta?: Record<string, any>;
    config: PinConfig;
}): Promise<{ tabid: string }> {
    return TabRpcClient.wshRpcCall(
        ViewPinBuildCommand,
        { workspaceid: globalStore.get(atoms.workspaceId), ...req },
        { route: ViewPinRoute, timeout: BuildTimeoutMs }
    );
}

export async function finishPinPage(pins: ViewPins): Promise<void> {
    const draft = globalStore.get(pins.draftAtom);
    if (draft == null) {
        return;
    }
    globalStore.set(pins.draftAtom, null);
    const tab = globalStore.get(tabAtom(draft.tabId));
    const name = draft.name.trim() || tab?.name || "";
    if (tab != null && name !== tab.name) {
        await RpcApi.UpdateTabNameCommand(TabRpcClient, draft.tabId, name);
    }
    if (draft.scope === "everywhere") {
        await pinEverywhere(pins, draft.tabId, name, draft.icon);
        return;
    }
    await pinHere(draft.tabId, name);
}

async function pinHere(tabId: string, name: string): Promise<void> {
    try {
        const config = await capture(tabId);
        await setTabMeta(tabId, {
            ...UnpinnedTabMeta,
            [PinMetaKey]: PinWorkspace,
            [PinConfigMetaKey]: config,
        });
        const workspace = globalStore.get(atoms.workspace)?.name ?? "";
        showToast({
            title: t("sidebar.pins.pinnedHere", { name, workspace }),
            actions: [{ id: "undo", label: t("sidebar.pins.undo"), run: () => setTabMeta(tabId, UnpinnedTabMeta) }],
        });
    } catch (e) {
        pinError(e);
    }
}

export async function pinEverywhere(pins: ViewPins, tabId: string, name: string, icon?: string): Promise<void> {
    try {
        const config = await capture(tabId);
        const tab = globalStore.get(tabAtom(tabId));
        const before = pins.globalPins();
        const pin: GlobalPin = {
            id: makeGlobalPinId(Date.now(), Math.random()),
            name,
            icon: icon ?? (tab?.meta?.["tab:icon"] as string) ?? undefined,
            rev: 1,
            config,
        };
        await writeGlobalPins(pins, [...before, pin]);
        await setTabMeta(tabId, { ...UnpinnedTabMeta, [GlobalPinMetaKey]: pin.id, [GlobalPinRevMetaKey]: 1 });
        showToast({
            title: t("sidebar.pins.pinnedEverywhere", { name }),
            actions: [
                {
                    id: "undo",
                    label: t("sidebar.pins.undo"),
                    run: async () => {
                        await writeGlobalPins(pins, withoutPin(pins.globalPins(), pin.id));
                        await setTabMeta(tabId, UnpinnedTabMeta);
                    },
                },
            ],
        });
    } catch (e) {
        pinError(e);
    }
}

// A view pinned everywhere becomes pinned only in this workspace: its configuration stays with this instance, the
// other workspaces keep theirs as temporary views.
export async function pinOnlyHere(pins: ViewPins, tabId: string): Promise<void> {
    const tab = globalStore.get(tabAtom(tabId));
    const pin = pins.globalPins().find((p) => p.id === tab?.meta?.[GlobalPinMetaKey]);
    if (pin == null) {
        return;
    }
    try {
        await setTabMeta(tabId, {
            ...UnpinnedTabMeta,
            [PinMetaKey]: PinWorkspace,
            [PinConfigMetaKey]: pin.config,
        });
        await writeGlobalPins(pins, withoutPin(pins.globalPins(), pin.id));
        const workspace = globalStore.get(atoms.workspace)?.name ?? "";
        showToast({ title: t("sidebar.pins.pinnedOnlyHere", { name: pin.name, workspace }) });
    } catch (e) {
        pinError(e);
    }
}

export async function unpin(pins: ViewPins, tabId: string): Promise<void> {
    const tab = globalStore.get(tabAtom(tabId));
    if (tab == null) {
        return;
    }
    const all = pins.globalPins();
    const pin = all.find((p) => p.id === tab.meta?.[GlobalPinMetaKey]);
    const before = {
        [PinMetaKey]: tab.meta?.[PinMetaKey] ?? null,
        [PinConfigMetaKey]: tab.meta?.[PinConfigMetaKey] ?? null,
        [GlobalPinMetaKey]: tab.meta?.[GlobalPinMetaKey] ?? null,
        [GlobalPinRevMetaKey]: tab.meta?.[GlobalPinRevMetaKey] ?? null,
    };
    try {
        await setTabMeta(tabId, UnpinnedTabMeta);
        if (pin != null) {
            await writeGlobalPins(pins, withoutPin(all, pin.id));
        }
        showToast({
            title: t("sidebar.pins.unpinned", { name: pin?.name ?? tab.name }),
            actions: [
                {
                    id: "undo",
                    label: t("sidebar.pins.undo"),
                    run: async () => {
                        if (pin != null) {
                            const at = all.findIndex((p) => p.id === pin.id);
                            const now = withoutPin(pins.globalPins(), pin.id);
                            await writeGlobalPins(pins, [...now.slice(0, at), pin, ...now.slice(at)]);
                        }
                        await setTabMeta(tabId, before);
                    },
                },
            ],
        });
    } catch (e) {
        pinError(e);
    }
}

// Unpins a view pinned everywhere that this workspace never opened.
export async function unpinGlobal(pins: ViewPins, pinId: string): Promise<void> {
    const all = pins.globalPins();
    const pin = all.find((p) => p.id === pinId);
    if (pin == null) {
        return;
    }
    try {
        await writeGlobalPins(pins, withoutPin(all, pinId));
        showToast({
            title: t("sidebar.pins.unpinned", { name: pin.name }),
            actions: [
                {
                    id: "undo",
                    label: t("sidebar.pins.undo"),
                    run: async () => {
                        const at = all.findIndex((p) => p.id === pinId);
                        const now = withoutPin(pins.globalPins(), pinId);
                        await writeGlobalPins(pins, [...now.slice(0, at), pin, ...now.slice(at)]);
                    },
                },
            ],
        });
    } catch (e) {
        pinError(e);
    }
}

// Save the current state: the view's configuration becomes what it shows; for a view pinned everywhere, every
// workspace's instance takes it the next time it opens (an instance whose agent works keeps its panels).
export async function saveState(pins: ViewPins, tabId: string): Promise<void> {
    const tab = globalStore.get(tabAtom(tabId));
    const state = globalStore.get(pins.stateAtom(tabId));
    try {
        const config = await capture(tabId);
        if (state === "workspace") {
            await setTabMeta(tabId, { [PinConfigMetaKey]: config });
            showToast({ title: t("sidebar.pins.saved", { name: tab?.name ?? "" }) });
            return;
        }
        const pin = pins.globalPins().find((p) => p.id === tab?.meta?.[GlobalPinMetaKey]);
        if (pin == null) {
            return;
        }
        const next: GlobalPin = { ...pin, rev: (pin.rev ?? 0) + 1, config };
        await writeGlobalPins(pins, replacePin(pins.globalPins(), next));
        await setTabMeta(tabId, { [GlobalPinRevMetaKey]: next.rev });
        showToast({ title: t("sidebar.pins.savedEverywhere", { name: pin.name }) });
    } catch (e) {
        pinError(e);
    }
}

// Back to the pinned state: the view's panels are made again from its configuration.
export async function revert(pins: ViewPins, tabId: string): Promise<void> {
    const tab = globalStore.get(tabAtom(tabId));
    const state = globalStore.get(pins.stateAtom(tabId));
    const pin = pins.globalPins().find((p) => p.id === tab?.meta?.[GlobalPinMetaKey]);
    const config = state === "workspace" ? readPinConfig(tab?.meta?.[PinConfigMetaKey]) : pin?.config;
    if (config == null) {
        return;
    }
    try {
        await build({ tabid: tabId, config });
        if (state === "everywhere") {
            await setTabMeta(tabId, { [GlobalPinRevMetaKey]: pin.rev });
        }
        showToast({ title: t("sidebar.pins.reverted", { name: pin?.name ?? tab?.name ?? "" }) });
    } catch (e) {
        pinError(e);
    }
}

// A block of the top row: this workspace's own instance of the view, made on its project the first time, and
// made again when the pin was saved from another workspace and no agent works in it.
export async function openGlobalPin(pins: ViewPins, pinId: string, instanceTabId: string): Promise<void> {
    const pin = pins.globalPins().find((p) => p.id === pinId);
    if (pin == null) {
        return;
    }
    try {
        if (instanceTabId) {
            const tab = globalStore.get(tabAtom(instanceTabId));
            const data = globalStore.get(AgentStates.getInstance().dataAtom);
            if (instanceStale(tab, pin) && !viewBusy(data, tab?.blockids)) {
                await build({ tabid: instanceTabId, config: pin.config });
                await setTabMeta(instanceTabId, { [GlobalPinRevMetaKey]: pin.rev });
            }
            getApi().setActiveTab(instanceTabId);
            return;
        }
        await build({
            name: pin.name,
            tabmeta: {
                [GlobalPinMetaKey]: pin.id,
                [GlobalPinRevMetaKey]: pin.rev,
                ...(pin.icon ? { "tab:icon": pin.icon } : {}),
            },
            config: pin.config,
        });
    } catch (e) {
        pinError(e);
    }
}

async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < WaitSteps && !cond(); i++) {
        await new Promise((r) => setTimeout(r, WaitStepMs));
    }
}

// Close the finished views: every temporary view whose agents are done; one where an agent still works or waits
// stays. Each close is recorded, so Undo (and Reopen closed) brings them back.
export async function closeFinished(pins: ViewPins): Promise<void> {
    const ids = globalStore.get(pins.finishedAtom);
    const ws = globalStore.get(atoms.workspace);
    if (ids.length === 0 || ws == null) {
        return;
    }
    const own = globalStore.get(atoms.staticTabId);
    const closingOwn = ids.includes(own);
    if (closingOwn) {
        // This window's view closes with the others, and its toasts with it: a view that stays comes on screen
        // first, and shows the toast once the closes are done (showClosedFinished).
        const survivor = (ws.tabids ?? []).find((id) => !ids.includes(id));
        if (survivor != null) {
            getApi().setActiveTab(survivor);
            await waitFor(() => globalStore.get(atoms.workspace)?.activetabid === survivor);
        }
    }
    const close = recordingTabClose(getApi().closeTab);
    let closed = closingOwn ? 1 : 0;
    for (const id of ids.filter((id) => id !== own)) {
        try {
            if (await close(ws.oid, id, false)) {
                closed++;
            }
        } catch (e) {
            console.log("closing a finished view", e);
        }
    }
    if (closed === 0) {
        return;
    }
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("workspace", ws.oid),
        meta: {
            [ClosedFinishedMetaKey]: {
                count: closed,
                at: Date.now(),
                id: makeGlobalPinId(Date.now(), Math.random()),
            },
        } as MetaType,
    });
    if (closingOwn) {
        await close(ws.oid, own, false);
    }
}

// The toast of Close the finished views, with its Undo, shown by the view on screen once the closes are done.
export function showClosedFinished(pins: ViewPins, value: any) {
    const ws = globalStore.get(atoms.workspace);
    if (value == null || typeof value.count !== "number" || ws == null || pins.closedShown.has(value.id)) {
        return;
    }
    if (globalStore.get(atoms.staticTabId) !== ws.activetabid || Date.now() - (value.at ?? 0) > ClosedToastMs) {
        return;
    }
    pins.closedShown.add(value.id);
    const count = value.count as number;
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("workspace", ws.oid),
            meta: { [ClosedFinishedMetaKey]: null } as MetaType,
        })
    );
    showToast({
        title: tCount("sidebar.pins.closedFinished", count),
        message: t("sidebar.pins.closedFinishedHint"),
        actions: [
            {
                id: "undo",
                label: t("sidebar.pins.undo"),
                run: async () => {
                    for (let i = 0; i < count; i++) {
                        await reopenLastQuietly();
                    }
                },
            },
        ],
    });
}

// "Start an agent" in an agent slot of a view pinned everywhere: the project's coding agent, typed into the slot's
// terminal once its shell runs. A project without a supported agent says so.
export async function startAgentInSlot(blockId: string): Promise<void> {
    const dir = readWorkspaceProject(globalStore.get(atoms.workspace)).dir;
    try {
        const agent = pipelineAgentOf(await fetchCodingAgent(dir), globalStore.get(atoms.fullConfigAtom)?.presets);
        if (agent.state === "missing") {
            showToast({ kind: "warning", title: t("codingAgent.missing", { agent: agent.name }) });
            return;
        }
        if (agent.state !== "ready") {
            showToast({ kind: "warning", title: t("sidebar.pins.noAgent") });
            return;
        }
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", blockId),
            meta: { [AgentSlotMetaKey]: null } as MetaType,
        });
        await typeCommandWhenReady(blockId, agent.agent.command);
    } catch (e) {
        pinError(e);
    }
}
