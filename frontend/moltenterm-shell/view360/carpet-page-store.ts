// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the carpet's tab strip reads of a web page panel (FR-SHELL-125): its favicon once loaded, the agent that opened
// it, and its page actions for the tab menu. Read from the panel's own view model (browser-view.tsx), which keeps them
// in memory, so this file stays free of the browser's React code.

import { getBlockComponentModel } from "@/app/store/global";
import { atom, Atom } from "jotai";
import type { BrowserState, BrowserTab } from "../browser/browser-model";
import { MoltentermBrowserView } from "../browser/browser-model";
import type { BrowserTabActions } from "../browser/browser-tab-menu";
import { pageOpener, type PageAgentTab } from "./carpet-tabs-model";

// The part of BrowserViewModel the strip uses.
export type CarpetPageModel = BrowserTabActions & {
    viewType: string;
    stateAtom: Atom<BrowserState>;
    loads: { loadsAtom: Atom<Record<string, { favicon?: string }>> };
    agents: { tabsAtom: Atom<Record<string, PageAgentTab>> };
    shareItems?: (tab: BrowserTab) => Promise<ContextMenuItem[]>;
};

export type CarpetPageFacts = { favicon: string; agentName: string };

export function carpetPageModel(blockId: string): CarpetPageModel {
    const vm = (blockId ? getBlockComponentModel(blockId)?.viewModel : null) as unknown as CarpetPageModel;
    if (vm?.viewType !== MoltentermBrowserView || vm.stateAtom == null) {
        return null;
    }
    return vm;
}

export function activePageTab(state: BrowserState): BrowserTab {
    return state?.tabs?.find((tab) => tab.id === state.activeId) ?? null;
}

function samePages(a: Record<string, CarpetPageFacts>, b: Record<string, CarpetPageFacts>): boolean {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) {
        return false;
    }
    return ka.every((k) => b[k] != null && a[k].favicon === b[k].favicon && a[k].agentName === b[k].agentName);
}

// One atom per set of page blocks. It hands back the same object while no favicon nor opener changed, so a page's
// loading progress does not render the strip again.
export function makeCarpetPagesAtom(blockIds: string[]): Atom<Record<string, CarpetPageFacts>> {
    const models = blockIds.map((id) => [id, carpetPageModel(id)] as const).filter(([, model]) => model != null);
    let last: Record<string, CarpetPageFacts> = {};
    return atom((get) => {
        const next: Record<string, CarpetPageFacts> = {};
        for (const [blockId, model] of models) {
            const state = get(model.stateAtom);
            const loads = model.loads?.loadsAtom == null ? {} : get(model.loads.loadsAtom);
            const agentTabs = model.agents?.tabsAtom == null ? {} : get(model.agents.tabsAtom);
            const active = activePageTab(state);
            next[blockId] = {
                favicon: active?.engine ? null : (loads?.[active?.id]?.favicon ?? null),
                agentName: pageOpener(active?.id, agentTabs),
            };
        }
        if (samePages(last, next)) {
            return last;
        }
        last = next;
        return next;
    });
}
