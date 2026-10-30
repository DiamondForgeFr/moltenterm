// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// How the "Store on the carpet" chooser names the two panels in its sentence (#1453): the agent by its first name
// alone, the page by its title. The radar's "Name · Tool" label is not reused here, a sentence never names the
// tool or the host of a page that has a title (provider-agnostic UI text).

import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { atom, Atom } from "jotai";
import { agentCallName, type AgentStateInfo } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { browserTabTitle, MoltentermBrowserView, readBrowserState } from "../browser/browser-model";
import { I18nModel } from "../i18n/i18n";
import { PanelMeta, panelTitle } from "../tab-identity";
import { getHomeDir } from "../tab-identity-ui";

export function placeSentenceName(meta: PanelMeta & Record<string, any>, agentInfo: AgentStateInfo, home = ""): string {
    if (agentInfo != null) {
        return agentCallName(agentInfo);
    }
    const custom = String(meta?.["frame:title"] ?? "").trim();
    if (custom) {
        return custom;
    }
    if (meta?.view === MoltentermBrowserView) {
        const state = readBrowserState(meta, "");
        const tab = state.tabs.find((x) => x.id === state.activeId) ?? state.tabs[0];
        const page = tab == null ? "" : browserTabTitle(tab);
        if (page) {
            return page;
        }
    }
    return panelTitle(meta, home);
}

export function makePlaceNamesAtom(blockIds: string[]): Atom<Record<string, string>> {
    let last: Record<string, string> = {};
    return atom((get) => {
        get(I18nModel.getInstance().localeAtom);
        const agents = get(AgentStates.getInstance().dataAtom).states;
        const next: Record<string, string> = {};
        for (const blockId of blockIds) {
            const block = get(getWaveObjectAtom<Block>(makeORef("block", blockId)));
            next[blockId] = placeSentenceName((block?.meta ?? {}) as PanelMeta, agents[blockId], getHomeDir());
        }
        const same =
            Object.keys(next).length === Object.keys(last).length && Object.keys(next).every((k) => next[k] === last[k]);
        if (same) {
            return last;
        }
        last = next;
        return next;
    });
}
