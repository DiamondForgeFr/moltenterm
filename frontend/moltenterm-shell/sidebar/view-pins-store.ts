// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The three states of a view (FR-SHELL-080) in the window: pinning in the workspace (the tab keeps its
// configuration), pinning everywhere (the client keeps one configuration, each workspace opens its own instance on
// its own project), unpinning, saving a changed pinned view or bringing it back, and closing the finished temporary
// views. wavesrv reads and makes the views (pkg/molten/viewpin).

import { ClientModel } from "@/app/store/client-model";
import { atoms, getApi, globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
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
    PinScope,
    PinWorkspace,
    readGlobalPins,
    readPinConfig,
    replacePin,
    UnpinnedTabMeta,
    viewBusy,
    viewFinished,
    viewModified,
    ViewPinBuildCommand,
    ViewPinCaptureCommand,
    ViewPinRoute,
    ViewState,
    viewStateOf,
    withoutPin,
} from "./view-pins-model";

const CaptureTimeoutMs = 10000;
const BuildTimeoutMs = 15000;
// The workspace's meta: the last Close the finished views, for the view on screen to show its toast.
const ClosedFinishedMetaKey = "molten:closedfinished";
const ClosedToastMs = 15000;
const WaitSteps = 50;
const WaitStepMs = 100;

// The pin page: the view being pinned, its name and the scope chosen.
export type PinDraft = { tabId: string; name: string; scope: PinScope; icon?: string };

function tabAtom(tabId: string): jotai.Atom<Tab> {
    return WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId));
}

function blockMetaOf(get: jotai.Getter, blockId: string): Record<string, any> {
    return get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)))?.meta ?? null;
}

function pinError(e: any) {
    showToast({ kind: "error", title: t("sidebar.pins.failed"), message: String(e?.message ?? e) });
}

export class ViewPins {
    private static instance: ViewPins = null;

    draftAtom = jotai.atom(null) as jotai.PrimitiveAtom<PinDraft>;
    // The pins this window just wrote, until the client's meta echoes them.
    pendingPinsAtom = jotai.atom(null) as jotai.PrimitiveAtom<GlobalPin[]>;
    globalPinsAtom!: jotai.Atom<GlobalPin[]>;
    stateAtoms = new Map<string, jotai.Atom<ViewState>>();
    modifiedAtoms = new Map<string, jotai.Atom<boolean>>();
    finishedAtom!: jotai.Atom<string[]>;
    closedShown = new Set<string>();

    private constructor() {
        this.globalPinsAtom = jotai.atom((get) => {
            const pending = get(this.pendingPinsAtom);
            if (pending != null) {
                return pending;
            }
            const clientAtom = ClientModel.getInstance().clientAtom;
            return readGlobalPins(clientAtom == null ? null : get(clientAtom)?.meta);
        });
        this.finishedAtom = jotai.atom((get) => {
            const data = get(AgentStates.getInstance().dataAtom);
            const ids = new Set(get(this.globalPinsAtom).map((p) => p.id));
            const ws = get(atoms.workspace);
            return (ws?.tabids ?? []).filter((id) => {
                const tab = get(tabAtom(id));
                return tab != null && viewStateOf(tab, ids) === "temporary" && !tab.meta?.["molten:projecttab"]
                    ? viewFinished(data, tab.blockids)
                    : false;
            });
        });
    }

    static getInstance(): ViewPins {
        if (ViewPins.instance == null) {
            ViewPins.instance = new ViewPins();
        }
        return ViewPins.instance;
    }

    globalPins(): GlobalPin[] {
        return globalStore.get(this.globalPinsAtom);
    }

    stateAtom(tabId: string): jotai.Atom<ViewState> {
        let rtn = this.stateAtoms.get(tabId);
        if (rtn == null) {
            rtn = jotai.atom((get) =>
                viewStateOf(get(tabAtom(tabId)), new Set(get(this.globalPinsAtom).map((p) => p.id)))
            );
            this.stateAtoms.set(tabId, rtn);
        }
        return rtn;
    }

    // The configuration a pinned view is compared with: its own, or its pin everywhere's.
    private configOf(get: jotai.Getter, tab: Tab): PinConfig {
        const pins = get(this.globalPinsAtom);
        const state = viewStateOf(tab, new Set(pins.map((p) => p.id)));
        if (state === "workspace") {
            return readPinConfig(tab.meta[PinConfigMetaKey]);
        }
        if (state === "everywhere") {
            return pins.find((p) => p.id === tab.meta[GlobalPinMetaKey])?.config ?? null;
        }
        return null;
    }

    modifiedAtom(tabId: string): jotai.Atom<boolean> {
        let rtn = this.modifiedAtoms.get(tabId);
        if (rtn == null) {
            rtn = jotai.atom((get) => {
                if (!tabId) {
                    return false;
                }
                const tab = get(tabAtom(tabId));
                if (tab?.layoutstate == null) {
                    return false;
                }
                const config = this.configOf(get, tab);
                if (config == null) {
                    return false;
                }
                const metaOf = (id: string) => blockMetaOf(get, id);
                // The tab on screen: its layout model's live tree. The stored layout is written in place by this
                // window, so it never signals a change here; the model's leaves do.
                const live = tabId === get(atoms.staticTabId) ? getLayoutModelForStaticTab() : null;
                if (live != null) {
                    get(live.leafs);
                    return viewModified(config, layoutTree(live.treeState?.rootNode), metaOf);
                }
                const layout = get(WOS.getWaveObjectAtom<LayoutState>(WOS.makeORef("layout", tab.layoutstate)));
                return viewModified(config, layoutTree(layout?.rootnode), metaOf);
            });
            this.modifiedAtoms.set(tabId, rtn);
        }
        return rtn;
    }

    private writeGlobalPins(pins: GlobalPin[]): Promise<void> {
        const clientId = ClientModel.getInstance().clientId;
        globalStore.set(this.pendingPinsAtom, pins);
        return RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("client", clientId),
            meta: { [GlobalPinsMetaKey]: pins } as MetaType,
        }).finally(() => {
            if (globalStore.get(this.pendingPinsAtom) === pins) {
                globalStore.set(this.pendingPinsAtom, null);
            }
        });
    }

    private setTabMeta(tabId: string, meta: Record<string, any>): Promise<void> {
        return RpcApi.SetMetaCommand(TabRpcClient, { oref: WOS.makeORef("tab", tabId), meta: meta as MetaType });
    }

    // The view's layout as the window shows it: the live tree for the tab on screen (the stored one lags behind).
    private treeOf(tabId: string): PinNode {
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

    async capture(tabId: string): Promise<PinConfig> {
        const tab = globalStore.get(tabAtom(tabId));
        const data = globalStore.get(AgentStates.getInstance().dataAtom);
        return TabRpcClient.wshRpcCall(
            ViewPinCaptureCommand,
            {
                workspaceid: globalStore.get(atoms.workspaceId),
                tabid: tabId,
                tree: this.treeOf(tabId),
                agentblocks: agentBlocksOf(data, tab?.blockids ?? []),
            },
            { route: ViewPinRoute, timeout: CaptureTimeoutMs }
        );
    }

    private build(req: {
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

    openPinPage(tabId: string, name: string, icon: string, scope: PinScope = "here") {
        globalStore.set(this.draftAtom, { tabId, name, scope, icon });
    }

    closePinPage() {
        globalStore.set(this.draftAtom, null);
    }

    async finishPinPage(): Promise<void> {
        const draft = globalStore.get(this.draftAtom);
        if (draft == null) {
            return;
        }
        globalStore.set(this.draftAtom, null);
        const tab = globalStore.get(tabAtom(draft.tabId));
        const name = draft.name.trim() || tab?.name || "";
        if (tab != null && name !== tab.name) {
            await RpcApi.UpdateTabNameCommand(TabRpcClient, draft.tabId, name);
        }
        if (draft.scope === "everywhere") {
            await this.pinEverywhere(draft.tabId, name, draft.icon);
            return;
        }
        await this.pinHere(draft.tabId, name);
    }

    async pinHere(tabId: string, name: string): Promise<void> {
        try {
            const config = await this.capture(tabId);
            await this.setTabMeta(tabId, {
                ...UnpinnedTabMeta,
                [PinMetaKey]: PinWorkspace,
                [PinConfigMetaKey]: config,
            });
            const workspace = globalStore.get(atoms.workspace)?.name ?? "";
            showToast({
                title: t("sidebar.pins.pinnedHere", { name, workspace }),
                actions: [
                    { id: "undo", label: t("sidebar.pins.undo"), run: () => this.setTabMeta(tabId, UnpinnedTabMeta) },
                ],
            });
        } catch (e) {
            pinError(e);
        }
    }

    async pinEverywhere(tabId: string, name: string, icon?: string): Promise<void> {
        try {
            const config = await this.capture(tabId);
            const tab = globalStore.get(tabAtom(tabId));
            const before = this.globalPins();
            const pin: GlobalPin = {
                id: makeGlobalPinId(Date.now(), Math.random()),
                name,
                icon: icon ?? (tab?.meta?.["tab:icon"] as string) ?? undefined,
                rev: 1,
                config,
            };
            await this.writeGlobalPins([...before, pin]);
            await this.setTabMeta(tabId, { ...UnpinnedTabMeta, [GlobalPinMetaKey]: pin.id, [GlobalPinRevMetaKey]: 1 });
            showToast({
                title: t("sidebar.pins.pinnedEverywhere", { name }),
                actions: [
                    {
                        id: "undo",
                        label: t("sidebar.pins.undo"),
                        run: async () => {
                            await this.writeGlobalPins(withoutPin(this.globalPins(), pin.id));
                            await this.setTabMeta(tabId, UnpinnedTabMeta);
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
    async pinOnlyHere(tabId: string): Promise<void> {
        const tab = globalStore.get(tabAtom(tabId));
        const pin = this.globalPins().find((p) => p.id === tab?.meta?.[GlobalPinMetaKey]);
        if (pin == null) {
            return;
        }
        try {
            await this.setTabMeta(tabId, {
                ...UnpinnedTabMeta,
                [PinMetaKey]: PinWorkspace,
                [PinConfigMetaKey]: pin.config,
            });
            await this.writeGlobalPins(withoutPin(this.globalPins(), pin.id));
            const workspace = globalStore.get(atoms.workspace)?.name ?? "";
            showToast({ title: t("sidebar.pins.pinnedOnlyHere", { name: pin.name, workspace }) });
        } catch (e) {
            pinError(e);
        }
    }

    async unpin(tabId: string): Promise<void> {
        const tab = globalStore.get(tabAtom(tabId));
        if (tab == null) {
            return;
        }
        const pins = this.globalPins();
        const pin = pins.find((p) => p.id === tab.meta?.[GlobalPinMetaKey]);
        const before = {
            [PinMetaKey]: tab.meta?.[PinMetaKey] ?? null,
            [PinConfigMetaKey]: tab.meta?.[PinConfigMetaKey] ?? null,
            [GlobalPinMetaKey]: tab.meta?.[GlobalPinMetaKey] ?? null,
            [GlobalPinRevMetaKey]: tab.meta?.[GlobalPinRevMetaKey] ?? null,
        };
        try {
            await this.setTabMeta(tabId, UnpinnedTabMeta);
            if (pin != null) {
                await this.writeGlobalPins(withoutPin(pins, pin.id));
            }
            showToast({
                title: t("sidebar.pins.unpinned", { name: pin?.name ?? tab.name }),
                actions: [
                    {
                        id: "undo",
                        label: t("sidebar.pins.undo"),
                        run: async () => {
                            if (pin != null) {
                                const at = pins.findIndex((p) => p.id === pin.id);
                                const now = withoutPin(this.globalPins(), pin.id);
                                await this.writeGlobalPins([...now.slice(0, at), pin, ...now.slice(at)]);
                            }
                            await this.setTabMeta(tabId, before);
                        },
                    },
                ],
            });
        } catch (e) {
            pinError(e);
        }
    }

    // Unpins a view pinned everywhere that this workspace never opened.
    async unpinGlobal(pinId: string): Promise<void> {
        const pins = this.globalPins();
        const pin = pins.find((p) => p.id === pinId);
        if (pin == null) {
            return;
        }
        try {
            await this.writeGlobalPins(withoutPin(pins, pinId));
            showToast({
                title: t("sidebar.pins.unpinned", { name: pin.name }),
                actions: [
                    {
                        id: "undo",
                        label: t("sidebar.pins.undo"),
                        run: async () => {
                            const at = pins.findIndex((p) => p.id === pinId);
                            const now = withoutPin(this.globalPins(), pinId);
                            await this.writeGlobalPins([...now.slice(0, at), pin, ...now.slice(at)]);
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
    async saveState(tabId: string): Promise<void> {
        const tab = globalStore.get(tabAtom(tabId));
        const state = globalStore.get(this.stateAtom(tabId));
        try {
            const config = await this.capture(tabId);
            if (state === "workspace") {
                await this.setTabMeta(tabId, { [PinConfigMetaKey]: config });
                showToast({ title: t("sidebar.pins.saved", { name: tab?.name ?? "" }) });
                return;
            }
            const pin = this.globalPins().find((p) => p.id === tab?.meta?.[GlobalPinMetaKey]);
            if (pin == null) {
                return;
            }
            const next: GlobalPin = { ...pin, rev: (pin.rev ?? 0) + 1, config };
            await this.writeGlobalPins(replacePin(this.globalPins(), next));
            await this.setTabMeta(tabId, { [GlobalPinRevMetaKey]: next.rev });
            showToast({ title: t("sidebar.pins.savedEverywhere", { name: pin.name }) });
        } catch (e) {
            pinError(e);
        }
    }

    // Back to the pinned state: the view's panels are made again from its configuration.
    async revert(tabId: string): Promise<void> {
        const tab = globalStore.get(tabAtom(tabId));
        const state = globalStore.get(this.stateAtom(tabId));
        const pin = this.globalPins().find((p) => p.id === tab?.meta?.[GlobalPinMetaKey]);
        const config = state === "workspace" ? readPinConfig(tab?.meta?.[PinConfigMetaKey]) : pin?.config;
        if (config == null) {
            return;
        }
        try {
            await this.build({ tabid: tabId, config });
            if (state === "everywhere") {
                await this.setTabMeta(tabId, { [GlobalPinRevMetaKey]: pin.rev });
            }
            showToast({ title: t("sidebar.pins.reverted", { name: pin?.name ?? tab?.name ?? "" }) });
        } catch (e) {
            pinError(e);
        }
    }

    // A block of the top row: this workspace's own instance of the view, made on its project the first time, and
    // made again when the pin was saved from another workspace and no agent works in it.
    async openGlobalPin(pinId: string, instanceTabId: string): Promise<void> {
        const pin = this.globalPins().find((p) => p.id === pinId);
        if (pin == null) {
            return;
        }
        try {
            if (instanceTabId) {
                const tab = globalStore.get(tabAtom(instanceTabId));
                const data = globalStore.get(AgentStates.getInstance().dataAtom);
                if (instanceStale(tab, pin) && !viewBusy(data, tab?.blockids)) {
                    await this.build({ tabid: instanceTabId, config: pin.config });
                    await this.setTabMeta(instanceTabId, { [GlobalPinRevMetaKey]: pin.rev });
                }
                getApi().setActiveTab(instanceTabId);
                return;
            }
            await this.build({
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

    // Close the finished views: every temporary view whose agents are done; one where an agent still works or waits
    // stays. Each close is recorded, so Undo (and Reopen closed) brings them back.
    async closeFinished(): Promise<void> {
        const ids = globalStore.get(this.finishedAtom);
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
    showClosedFinished(value: any) {
        const ws = globalStore.get(atoms.workspace);
        if (value == null || typeof value.count !== "number" || ws == null || this.closedShown.has(value.id)) {
            return;
        }
        if (globalStore.get(atoms.staticTabId) !== ws.activetabid || Date.now() - (value.at ?? 0) > ClosedToastMs) {
            return;
        }
        this.closedShown.add(value.id);
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
}

async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < WaitSteps && !cond(); i++) {
        await new Promise((r) => setTimeout(r, WaitStepMs));
    }
}

// A pinned view does not close (FR-SHELL-080): its tab stays and the toast says to unpin it first. True when the
// close was refused.
export function refusePinnedClose(tabId: string): boolean {
    const tab = globalStore.get(tabAtom(tabId));
    if (tab == null || globalStore.get(ViewPins.getInstance().stateAtom(tabId)) === "temporary") {
        return false;
    }
    showToast({
        id: `pinned-close:${tabId}`,
        title: t("sidebar.pins.noClose", { name: tab.name ?? "" }),
        message: t("sidebar.pins.noCloseHint"),
    });
    return true;
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
