// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The window title, "MoltenTerm - <tab>": the tab view's document title, which Electron shows on the window. It reads
// the tab as the tab bar and the sidebar do: a Project tab is named in the interface language (#741), and a tab that
// keeps Wave's generic name (T1, T2…) is named after its first panel, which a view made with ⌘T gets after the window
// opened (#1345). The title follows both, and a language change.

import { globalStore } from "@/app/store/jotaiStore";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { MoltentermWindowTitle } from "@/util/moltenterm-identity";
import { atom, Atom } from "jotai";
import { I18nModel } from "./i18n/i18n";
import { tabShownName } from "./project/project-model";
import { PanelMeta, tabDisplayName } from "./tab-identity";
import { getHomeDir } from "./tab-identity-ui";

let titleTab: Tab = null;
let titleAtom: Atom<{ tab: Tab; panel: PanelMeta }> = null;
let stopTab: () => void = null;
let stopListening: () => void = null;

// The name the window shows for the tab and its first panel.
export function windowTabName(tab: Tab, firstPanel: PanelMeta, homeDir = ""): string {
    return tabDisplayName(tabShownName(tab), firstPanel, homeDir);
}

function applyTitle() {
    const facts = titleAtom != null ? globalStore.get(titleAtom) : { tab: titleTab, panel: null };
    document.title = `${MoltentermWindowTitle} - ${windowTabName(facts.tab ?? titleTab, facts.panel, getHomeDir())}`;
}

function makeTitleAtom(tabId: string): Atom<{ tab: Tab; panel: PanelMeta }> {
    const tabAtom = getWaveObjectAtom<Tab>(makeORef("tab", tabId));
    return atom((get) => {
        const tab = get(tabAtom);
        const blockIds = tab?.blockids ?? [];
        const first = blockIds.length > 0 ? get(getWaveObjectAtom<Block>(makeORef("block", blockIds[0]))) : null;
        return { tab, panel: (first?.meta ?? null) as PanelMeta };
    });
}

export function setWindowTitleTab(tab: Tab) {
    titleTab = tab;
    stopTab?.();
    stopTab = null;
    titleAtom = tab?.oid ? makeTitleAtom(tab.oid) : null;
    if (titleAtom != null) {
        stopTab = globalStore.sub(titleAtom, () => applyTitle());
    }
    applyTitle();
    if (stopListening == null) {
        stopListening = I18nModel.getInstance().onLocaleChange(() => applyTitle());
    }
}
