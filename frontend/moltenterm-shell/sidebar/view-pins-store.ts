// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The three states of a view (FR-SHELL-080) in the window: pinning in the workspace (the tab keeps its
// configuration), pinning everywhere (the client keeps one configuration, each workspace opens its own instance on
// its own project), unpinning, saving a changed pinned view or bringing it back, and closing the finished temporary
// views. wavesrv reads and makes the views (pkg/molten/viewpin).
//
// This module holds what the sidebar shows at first paint (the states, changed views, finished views); the actions
// and the pin page load on first use (view-pins-actions.ts, pin-page.tsx), out of the JS every tab view loads up
// front (NFR-PERF-003, bundle.initialJsMB).

import { ClientModel } from "@/app/store/client-model";
import { atoms, globalStore, WOS } from "@/app/store/global";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { AgentStates } from "../agent-state-store";
import { t } from "../i18n/i18n";
import { showToast } from "../toast-store";
import type * as PinPageModule from "./pin-page";
import type * as ViewPinsActions from "./view-pins-actions";
import {
    GlobalPin,
    GlobalPinMetaKey,
    layoutTree,
    PinConfig,
    PinConfigMetaKey,
    PinScope,
    readGlobalPins,
    readPinConfig,
    viewFinished,
    viewModified,
    ViewState,
    viewStateOf,
} from "./view-pins-model";

// The workspace's meta: the last Close the finished views, for the view on screen to show its toast.
export const ClosedFinishedMetaKey = "molten:closedfinished";

// The pin page: the view being pinned, its name and the scope chosen.
export type PinDraft = { tabId: string; name: string; scope: PinScope; icon?: string };

export function tabAtom(tabId: string): jotai.Atom<Tab> {
    return WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId));
}

function blockMetaOf(get: jotai.Getter, blockId: string): Record<string, any> {
    return get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)))?.meta ?? null;
}

function pinActions(): Promise<typeof ViewPinsActions> {
    return import("./view-pins-actions");
}

let pinPageModule: typeof PinPageModule = null;

// The pin page once loaded: the draft is only set after it loads, so the page never renders a fallback.
export function loadedPinPage(): typeof PinPageModule {
    return pinPageModule;
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

    // Opens the pin page once its code has loaded, so the lists give way to the page in one step.
    openPinPage(tabId: string, name: string, icon: string, scope: PinScope = "here") {
        fireAndForget(async () => {
            pinPageModule ??= await import("./pin-page");
            globalStore.set(this.draftAtom, { tabId, name, scope, icon });
        });
    }

    closePinPage() {
        globalStore.set(this.draftAtom, null);
    }

    async finishPinPage(): Promise<void> {
        return (await pinActions()).finishPinPage(this);
    }

    async pinEverywhere(tabId: string, name: string, icon?: string): Promise<void> {
        return (await pinActions()).pinEverywhere(this, tabId, name, icon);
    }

    async pinOnlyHere(tabId: string): Promise<void> {
        return (await pinActions()).pinOnlyHere(this, tabId);
    }

    async unpin(tabId: string): Promise<void> {
        return (await pinActions()).unpin(this, tabId);
    }

    async unpinGlobal(pinId: string): Promise<void> {
        return (await pinActions()).unpinGlobal(this, pinId);
    }

    async saveState(tabId: string): Promise<void> {
        return (await pinActions()).saveState(this, tabId);
    }

    async revert(tabId: string): Promise<void> {
        return (await pinActions()).revert(this, tabId);
    }

    async openGlobalPin(pinId: string, instanceTabId: string): Promise<void> {
        return (await pinActions()).openGlobalPin(this, pinId, instanceTabId);
    }

    async closeFinished(): Promise<void> {
        return (await pinActions()).closeFinished(this);
    }

    // Nothing to show most of the time: the actions load only when a close of the finished views left its toast.
    showClosedFinished(value: any) {
        if (value == null || typeof value.count !== "number" || this.closedShown.has(value.id)) {
            return;
        }
        fireAndForget(async () => (await pinActions()).showClosedFinished(this, value));
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

export async function startAgentInSlot(blockId: string): Promise<void> {
    return (await pinActions()).startAgentInSlot(blockId);
}
