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
import { dismissToast, showToast } from "../toast-store";
import { workspaceShownName } from "../workspace-default-name";
import { readWorkspaceProject } from "../workspace-project";
import { showUndoToast } from "./sidebar-undo";
import { moveBeside, readViewIcon, sameOrder, undoOrder, ViewIconMetaKey, withMissingPanels } from "./view-menu-model";
import {
    agentBlocksOf,
    AgentSlotMetaKey,
    forkDue,
    forkOrigin,
    GlobalPin,
    GlobalPinMetaKey,
    GlobalPinRevMetaKey,
    GlobalPinsMetaKey,
    instanceStale,
    isProjectTab,
    layoutTree,
    makeGlobalPinId,
    PinConfig,
    PinConfigMetaKey,
    PinMetaKey,
    pinMetaOf,
    PinNode,
    PinScope,
    PinWorkspace,
    planPinUpdate,
    planViewFork,
    planViewMove,
    readGlobalPins,
    readPinConfig,
    replacePin,
    undoPins,
    undoPinUpdate,
    viewBusy,
    viewFinished,
    viewForked,
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
// The workspace's meta: the last Close the finished views or Clear, for the view on screen to show its toast.
const ClosedFinishedMetaKey = "molten:closedfinished";
const ClosedToastMs = 15000;
const WaitSteps = 50;
const WaitStepMs = 100;
// A change of an instance pinned everywhere must hold this long before it forks (#1272): a rebuild from the pin's
// configuration passes through partial layouts, a split by the developer stays.
const ForkSettleMs = 600;

// The pin page: the view being pinned, its name and the scope chosen.
export type PinDraft = { tabId: string; name: string; scope: PinScope };

// A view the menu acts on: its tab, and the pin of a view pinned everywhere (a top-row block this workspace never
// opened has no tab).
export type ViewRef = { tabId?: string; pinId?: string };

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
    forking = new Set<string>();

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

    // This window's view leaves its pin everywhere once its panels changed (#1272, forkDue). Only the tab this window
    // shows has a live layout, so each window watches its own.
    private forkDueAtom(tabId: string, dragging: jotai.Atom<boolean>): jotai.Atom<boolean> {
        return jotai.atom((get) => {
            const tab = get(tabAtom(tabId));
            if (tab == null) {
                return false;
            }
            const pins = get(this.globalPinsAtom);
            const state = viewStateOf(tab, new Set(pins.map((p) => p.id)));
            if (state !== "everywhere") {
                return false;
            }
            const pin = pins.find((p) => p.id === tab.meta?.[GlobalPinMetaKey]);
            const live = getLayoutModelForStaticTab();
            if (pin == null || live == null) {
                return false;
            }
            get(live.leafs);
            const layout = tab.layoutstate
                ? get(WOS.getWaveObjectAtom<LayoutState>(WOS.makeORef("layout", tab.layoutstate)))
                : null;
            return forkDue({
                state,
                changed: viewForked(pin.config, layoutTree(live.treeState?.rootNode), (id) => blockMetaOf(get, id)),
                projectTab: isProjectTab(tab),
                onScreen: get(atoms.workspace)?.activetabid === tabId,
                dragging: get(dragging) || get(live.activeDrag),
                pending: (layout?.pendingbackendactions?.length ?? 0) > 0,
                stale: instanceStale(tab, pin),
            });
        });
    }

    // Watches the view this window shows (dragging: the sidebar's drag); returns the stop.
    watchFork(tabId: string, dragging: jotai.Atom<boolean>): () => void {
        if (!tabId) {
            return () => {};
        }
        const due = this.forkDueAtom(tabId, dragging);
        let timer: ReturnType<typeof setTimeout> = null;
        const check = () => {
            clearTimeout(timer);
            timer = null;
            if (!globalStore.get(due)) {
                return;
            }
            timer = setTimeout(() => {
                timer = null;
                if (globalStore.get(due)) {
                    fireAndForget(() => this.fork(tabId));
                }
            }, ForkSettleMs);
        };
        const unsub = globalStore.sub(due, check);
        check();
        return () => {
            unsub();
            clearTimeout(timer);
        };
    }

    // The changed view leaves its pin and becomes a temporary view here (#1272): same tab, panels, sessions and name,
    // nothing moves on screen; the pin and the other workspaces keep the configuration.
    async fork(tabId: string): Promise<void> {
        const tab = globalStore.get(tabAtom(tabId));
        const pin = this.pinOf({ tabId });
        if (tab == null || pin == null || this.forking.has(tabId)) {
            return;
        }
        this.forking.add(tabId);
        try {
            await this.setTabMeta(tabId, planViewFork(pin));
            showToast({
                id: forkToastId(tabId),
                title: t("sidebar.pins.forked", { name: tab.name || pin.name }),
                message: t("sidebar.pins.forkedHint"),
                actions: [{ id: "update", label: t("sidebar.pins.updatePinned"), run: () => this.updatePinned(tabId) }],
            });
        } catch (e) {
            pinError(e);
        } finally {
            this.forking.delete(tabId);
        }
    }

    // The pin a temporary view came from, for its menu's Update the pinned view.
    forkOriginOf(tabId: string): GlobalPin {
        return forkOrigin(globalStore.get(tabAtom(tabId)), this.globalPins());
    }

    // Update the pinned view (#1272): the view's layout becomes the pin's configuration for every workspace, the view
    // this workspace's instance again. Undo (⌘Z) brings back the previous configuration and the temporary view.
    async updatePinned(tabId: string): Promise<void> {
        const tab = globalStore.get(tabAtom(tabId));
        const before = this.forkOriginOf(tabId);
        if (tab == null || before == null) {
            return;
        }
        try {
            const update = planPinUpdate(this.globalPins(), before.id, await this.capture(tabId));
            if (update == null) {
                return;
            }
            const others = this.instancesOf(before.id).filter((id) => id !== tabId);
            const metaBefore = pinMetaOf(tab.meta);
            const othersBefore = others.map((id) => ({ id, meta: pinMetaOf(globalStore.get(tabAtom(id))?.meta) }));
            await this.writeGlobalPins(update.pins);
            for (const id of others) {
                await this.setTabMeta(id, update.othersMeta);
            }
            await this.setTabMeta(tabId, update.tabMeta);
            dismissToast(forkToastId(tabId));
            showUndoToast(
                t("sidebar.pins.updatedPinned", { name: before.name }),
                async () => {
                    await this.writeGlobalPins(undoPinUpdate(this.globalPins(), before));
                    await this.setTabMeta(tabId, metaBefore);
                    for (const other of othersBefore) {
                        await this.setTabMeta(other.id, other.meta);
                    }
                },
                t("sidebar.pins.updatedPinnedHint")
            );
        } catch (e) {
            pinError(e);
        }
    }

    // Every instance of a pin in this workspace: one after a fork whose block was opened again.
    private instancesOf(pinId: string): string[] {
        const ids = globalStore.get(atoms.workspace)?.tabids ?? [];
        return ids.filter((id) => globalStore.get(tabAtom(id))?.meta?.[GlobalPinMetaKey] === pinId);
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

    // The view's layout as the window shows it: the live tree for the tab on screen (the stored one lags behind). Another
    // tab's stored layout is read from wavesrv: this window may never have loaded it (FR-SHELL-081, a view pinned or
    // duplicated from its menu while another is on screen).
    private async treeOf(tabId: string): Promise<PinNode> {
        if (tabId === globalStore.get(atoms.staticTabId)) {
            const live = getLayoutModelForStaticTab()?.treeState?.rootNode;
            if (live != null) {
                return layoutTree(live);
            }
        }
        const tab = globalStore.get(tabAtom(tabId));
        if (!tab?.layoutstate) {
            return null;
        }
        const layout = await WOS.reloadWaveObject<LayoutState>(WOS.makeORef("layout", tab.layoutstate));
        // A view not shown since panels were added keeps them in its pending layout actions, out of the stored tree:
        // they go on its right, as the window would place them.
        return withMissingPanels(layoutTree(layout?.rootnode), tab.blockids ?? []);
    }

    async capture(tabId: string): Promise<PinConfig> {
        const tab = globalStore.get(tabAtom(tabId));
        const data = globalStore.get(AgentStates.getInstance().dataAtom);
        return TabRpcClient.wshRpcCall(
            ViewPinCaptureCommand,
            {
                workspaceid: globalStore.get(atoms.workspaceId),
                tabid: tabId,
                tree: await this.treeOf(tabId),
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
        background?: boolean;
    }): Promise<{ tabid: string }> {
        return TabRpcClient.wshRpcCall(
            ViewPinBuildCommand,
            { workspaceid: globalStore.get(atoms.workspaceId), ...req },
            { route: ViewPinRoute, timeout: BuildTimeoutMs }
        );
    }

    openPinPage(tabId: string, name: string, scope: PinScope = "here") {
        globalStore.set(this.draftAtom, { tabId, name, scope });
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
            await this.pinEverywhere(draft.tabId, name);
            return;
        }
        await this.pinHere(draft.tabId, name);
    }

    // A temporary view becomes pinned in the workspace, a view pinned everywhere pinned only here (moveView).
    async pinHere(tabId: string, name: string): Promise<void> {
        await this.moveView({ tabId }, "workspace", name);
    }

    // The pin keeps the icon the developer chose for the view, never one picked for it (FR-SHELL-081).
    async pinEverywhere(tabId: string, name: string): Promise<void> {
        await this.moveView({ tabId }, "everywhere", name);
    }

    // A view pinned everywhere becomes pinned only in this workspace: its configuration stays with this instance, the
    // other workspaces keep theirs as temporary views. A block this workspace never opened gets its instance now.
    async pinOnlyHere(tabId: string, pinId?: string): Promise<void> {
        await this.moveView({ tabId: tabId || undefined, pinId }, "workspace");
    }

    // Rename (FR-SHELL-081): a view pinned everywhere is renamed in every workspace, through its pin.
    async rename(ref: ViewRef, name: string): Promise<void> {
        const value = name.trim();
        if (!value) {
            return;
        }
        try {
            const pin = this.pinOf(ref);
            if (pin != null && pin.name !== value) {
                await this.writeGlobalPins(replacePin(this.globalPins(), { ...pin, name: value }));
            }
            const tab = ref.tabId ? globalStore.get(tabAtom(ref.tabId)) : null;
            if (tab != null && tab.name !== value) {
                await RpcApi.UpdateTabNameCommand(TabRpcClient, ref.tabId, value);
            }
        } catch (e) {
            pinError(e);
        }
    }

    // Change icon (FR-SHELL-081): a chosen glyph replaces the panels' icons; null goes back to them. A view pinned
    // everywhere keeps it in its pin, so every workspace shows it.
    async setIcon(ref: ViewRef, icon: string): Promise<void> {
        const value = readViewIcon(icon);
        try {
            const pin = this.pinOf(ref);
            if (pin != null) {
                const next: GlobalPin = { ...pin, icon: value ?? undefined };
                if (value == null) {
                    delete next.icon;
                }
                await this.writeGlobalPins(replacePin(this.globalPins(), next));
                return;
            }
            if (ref.tabId) {
                await this.setTabMeta(ref.tabId, { [ViewIconMetaKey]: value });
            }
        } catch (e) {
            pinError(e);
        }
    }

    // The pin of a view pinned everywhere: named by the ref, or by its instance's tab.
    pinOf(ref: ViewRef): GlobalPin {
        const pins = this.globalPins();
        if (ref.pinId) {
            return pins.find((p) => p.id === ref.pinId) ?? null;
        }
        const tab = ref.tabId ? globalStore.get(tabAtom(ref.tabId)) : null;
        const gid = tab?.meta?.[GlobalPinMetaKey];
        return typeof gid === "string" ? (pins.find((p) => p.id === gid) ?? null) : null;
    }

    // Duplicate (FR-SHELL-081): the same configuration under "<name> (copy)", in the same state, placed right after the
    // view; a view pinned everywhere duplicates as another view pinned everywhere. The duplicate opens in the
    // background, so the view on screen stays.
    async duplicate(ref: ViewRef): Promise<void> {
        const pin = this.pinOf(ref);
        const tab = ref.tabId ? globalStore.get(tabAtom(ref.tabId)) : null;
        const state: ViewState = pin != null ? "everywhere" : tab != null ? viewStateOf(tab, new Set()) : null;
        if (state == null) {
            return;
        }
        const name = t("sidebar.views.copyName", { name: pin?.name ?? tab?.name ?? "" });
        try {
            const config = tab != null ? await this.capture(ref.tabId) : pin.config;
            let newPin: GlobalPin = null;
            if (pin != null) {
                newPin = { ...pin, id: makeGlobalPinId(Date.now(), Math.random()), name, rev: 1, config };
                const pins = this.globalPins();
                const at = pins.findIndex((p) => p.id === pin.id) + 1;
                await this.writeGlobalPins([...pins.slice(0, at), newPin, ...pins.slice(at)]);
            }
            let newTabId: string = null;
            if (tab != null) {
                const tabmeta: Record<string, any> =
                    newPin != null
                        ? { [GlobalPinMetaKey]: newPin.id, [GlobalPinRevMetaKey]: 1 }
                        : state === "workspace"
                          ? { [PinMetaKey]: PinWorkspace, [PinConfigMetaKey]: config }
                          : {};
                const icon = readViewIcon(tab.meta?.[ViewIconMetaKey]);
                if (icon != null && newPin == null) {
                    tabmeta[ViewIconMetaKey] = icon;
                }
                newTabId = (await this.build({ name, tabmeta, config, background: true }))?.tabid ?? null;
                if (newTabId) {
                    await this.placeAfter(newTabId, ref.tabId);
                }
            }
            showUndoToast(t("sidebar.views.duplicated", { name }), async () => {
                if (newPin != null) {
                    await this.writeGlobalPins(withoutPin(this.globalPins(), newPin.id));
                }
                const ws = globalStore.get(atoms.workspace);
                if (newTabId && ws != null) {
                    await getApi().closeTab(ws.oid, newTabId, false);
                }
            });
        } catch (e) {
            pinError(e);
        }
    }

    // Moves a new tab right after another in the workspace's order.
    private async placeAfter(tabId: string, afterId: string): Promise<void> {
        await waitFor(() => (globalStore.get(atoms.workspace)?.tabids ?? []).includes(tabId));
        const ws = globalStore.get(atoms.workspace);
        const ids = ws?.tabids ?? [];
        if (!ids.includes(tabId) || !ids.includes(afterId)) {
            return;
        }
        const next = moveBeside(ids, tabId, afterId, true);
        if (!sameOrder(next, ids)) {
            await RpcApi.UpdateWorkspaceTabIdsCommand(TabRpcClient, ws.oid, next);
        }
    }

    // Reorders the tiles (FR-SHELL-081): the dragged tile lands before or after the target, in the workspace's tab
    // order; Undo (⌘Z) brings the order back.
    async reorderTiles(dragged: string, target: string, after: boolean): Promise<void> {
        const ws = globalStore.get(atoms.workspace);
        const before = [...(ws?.tabids ?? [])];
        const next = moveBeside(before, dragged, target, after);
        if (ws == null || sameOrder(next, before)) {
            return;
        }
        try {
            await RpcApi.UpdateWorkspaceTabIdsCommand(TabRpcClient, ws.oid, next);
            showUndoToast(t("sidebar.views.reordered"), async () => {
                const restored = undoOrder(before, globalStore.get(atoms.workspace)?.tabids ?? []);
                if (restored != null) {
                    await RpcApi.UpdateWorkspaceTabIdsCommand(TabRpcClient, ws.oid, restored);
                }
            });
        } catch (e) {
            pinError(e);
        }
    }

    // Reorders the top row, the same in every workspace.
    async reorderTop(dragged: string, target: string, after: boolean): Promise<void> {
        const pins = this.globalPins();
        const before = pins.map((p) => p.id);
        const order = moveBeside(before, dragged, target, after);
        if (sameOrder(order, before)) {
            return;
        }
        const byId = new Map(pins.map((p) => [p.id, p]));
        try {
            await this.writeGlobalPins(order.map((id) => byId.get(id)));
            showUndoToast(t("sidebar.views.reordered"), async () => {
                const now = this.globalPins();
                const restored = undoOrder(
                    before,
                    now.map((p) => p.id)
                );
                if (restored != null) {
                    const current = new Map(now.map((p) => [p.id, p]));
                    await this.writeGlobalPins(restored.map((id) => current.get(id)));
                }
            });
        } catch (e) {
            pinError(e);
        }
    }

    // Make temporary: a view pinned everywhere keeps the icon its pin had.
    async unpin(tabId: string): Promise<void> {
        await this.moveView({ tabId }, "temporary");
    }

    // Make temporary a view pinned everywhere that this workspace never opened: its instance is made here, temporary.
    async unpinGlobal(pinId: string): Promise<void> {
        await this.moveView({ pinId }, "temporary");
    }

    // Moves a view to another state (FR-SHELL-080, #1244), keeping the view itself: only its tab's pin keys and the
    // pins everywhere change, never its panels, layout, name, background or sessions. Undo (⌘Z) brings back the state
    // it had. A top-row block this workspace never opened gets its instance here first; Undo closes it again.
    async moveView(view: ViewRef, to: ViewState, name?: string): Promise<void> {
        const ref: ViewRef = view.tabId || !view.pinId ? view : { ...view, tabId: this.instanceOf(view.pinId) };
        const tab = ref.tabId ? globalStore.get(tabAtom(ref.tabId)) : null;
        const pinsBefore = this.globalPins();
        const from: ViewState =
            tab != null ? viewStateOf(tab, new Set(pinsBefore.map((p) => p.id))) : ref.pinId ? "everywhere" : null;
        if (from == null || from === to || isProjectTab(tab)) {
            return;
        }
        try {
            const needsCapture = to === "everywhere" || (to === "workspace" && from === "temporary");
            const captured = needsCapture ? await this.capture(ref.tabId) : undefined;
            const shown = name ?? this.pinOf(ref)?.name ?? tab?.name ?? "";
            const move = planViewMove(from, to, {
                tabMeta: tab?.meta,
                pins: pinsBefore,
                pinId: ref.pinId,
                captured,
                name: shown,
                newPinId: to === "everywhere" ? makeGlobalPinId(Date.now(), Math.random()) : undefined,
            });
            if (move == null) {
                return;
            }
            const metaBefore = pinMetaOf(tab?.meta);
            let built: string = null;
            if (to === "everywhere") {
                await this.writeGlobalPins(move.pins);
                await this.setTabMeta(ref.tabId, move.tabMeta);
            } else {
                if (tab != null) {
                    await this.setTabMeta(ref.tabId, move.tabMeta);
                } else {
                    const req = {
                        name: move.pin.name,
                        tabmeta: move.tabMeta,
                        config: move.pin.config,
                        background: true,
                    };
                    built = (await this.build(req))?.tabid ?? null;
                }
                if (from === "everywhere") {
                    await this.writeGlobalPins(move.pins);
                }
            }
            showUndoToast(this.moveTitle(from, to, shown), async () => {
                if (move.pin != null) {
                    await this.writeGlobalPins(undoPins(pinsBefore, this.globalPins(), move.pin));
                }
                const ws = globalStore.get(atoms.workspace);
                if (built && ws != null) {
                    await getApi().closeTab(ws.oid, built, false);
                    return;
                }
                if (tab != null) {
                    await this.setTabMeta(ref.tabId, metaBefore);
                }
            });
        } catch (e) {
            pinError(e);
        }
    }

    // This workspace's instance of a view pinned everywhere, when it opened one.
    private instanceOf(pinId: string): string {
        const ids = globalStore.get(atoms.workspace)?.tabids ?? [];
        return ids.find((id) => globalStore.get(tabAtom(id))?.meta?.[GlobalPinMetaKey] === pinId) ?? undefined;
    }

    private moveTitle(from: ViewState, to: ViewState, name: string): string {
        const workspace = workspaceShownName(globalStore.get(atoms.workspace)?.name, t) || t("rail.unsavedWorkspace");
        if (to === "everywhere") {
            return t("sidebar.pins.pinnedEverywhere", { name });
        }
        if (to === "workspace") {
            return t(from === "everywhere" ? "sidebar.pins.pinnedOnlyHere" : "sidebar.pins.pinnedHere", {
                name,
                workspace,
            });
        }
        return t("sidebar.pins.unpinned", { name });
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
                // A rename from another workspace reaches this instance's tab.
                if (tab != null && pin.name && tab.name !== pin.name) {
                    await RpcApi.UpdateTabNameCommand(TabRpcClient, instanceTabId, pin.name);
                }
                getApi().setActiveTab(instanceTabId);
                return;
            }
            await this.build({
                name: pin.name,
                tabmeta: { [GlobalPinMetaKey]: pin.id, [GlobalPinRevMetaKey]: pin.rev },
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
            await showSurvivor(ids);
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
        await announceClosedViews(ws.oid, closed, "finished");
        if (closingOwn) {
            await close(ws.oid, own, false);
        }
    }

    // The toast of Close the finished views or of Clear (#1253), with its Undo (⌘Z too), shown by the view on screen
    // once the closes are done.
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
        showClosedViewsToast(count, value.kind);
    }
}

function forkToastId(tabId: string): string {
    return `view-fork:${tabId}`;
}

export const ClosedKindCleared = "cleared";

// The toast after Close the finished views or Clear: its Undo, and ⌘Z while it shows, reopen what closed.
export function showClosedViewsToast(
    count: number,
    kind: string,
    reopen: () => Promise<unknown> = reopenLastQuietly
): string {
    const cleared = kind === ClosedKindCleared;
    return showUndoToast(
        tCount(cleared ? "sidebar.temporary.cleared" : "sidebar.pins.closedFinished", count),
        () => reopenClosedViews(count, reopen),
        cleared ? undefined : t("sidebar.pins.closedFinishedHint")
    );
}

// Brings back the last count closes of the workspace, the latest first, through Reopen what was closed (#512).
async function reopenClosedViews(count: number, reopen: () => Promise<unknown>) {
    for (let i = 0; i < count; i++) {
        await reopen();
    }
}

// Tells the view on screen that count views just closed, so it shows the toast with Undo (showClosedFinished).
export async function announceClosedViews(workspaceId: string, count: number, kind: string): Promise<void> {
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("workspace", workspaceId),
        meta: {
            [ClosedFinishedMetaKey]: {
                count,
                kind,
                at: Date.now(),
                id: makeGlobalPinId(Date.now(), Math.random()),
            },
        } as MetaType,
    });
}

// This window's view closes with the others, and its toasts with it: a view that stays comes on screen first, and
// shows the toast once the closes are done. false: every view of the workspace is closing.
export async function showSurvivor(closing: readonly string[]): Promise<boolean> {
    const ws = globalStore.get(atoms.workspace);
    const survivor = (ws?.tabids ?? []).find((id) => !closing.includes(id));
    if (survivor == null) {
        return false;
    }
    getApi().setActiveTab(survivor);
    await waitFor(() => globalStore.get(atoms.workspace)?.activetabid === survivor);
    return true;
}

async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < WaitSteps && !cond(); i++) {
        await new Promise((r) => setTimeout(r, WaitStepMs));
    }
}

// Closing the last panel of a pinned view leaves the view, empty (FR-SHELL-081): wavesrv keeps its tab too
// (viewpin.Pinned).
export function pinnedViewKeepsTab(tabId: string): boolean {
    if (!tabId || globalStore.get(tabAtom(tabId)) == null) {
        return false;
    }
    return globalStore.get(ViewPins.getInstance().stateAtom(tabId)) !== "temporary";
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
