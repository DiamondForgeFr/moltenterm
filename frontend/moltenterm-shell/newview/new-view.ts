// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Opening a new view (FR-SHELL-089): ⌘T, the sidebar's New view, the palette's New view and the tab bar's + all come
// here. The chooser, or the type the developer chose to open directly; the favourites' direct shortcuts; and what the
// chooser does when an entry is picked or the view is cancelled.

import { atoms, getApi, getSettingsKeyAtom, globalStore, replaceBlock, WOS } from "@/app/store/global";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { isMacOS } from "@/util/platformutil";
import { fireAndForget } from "@/util/util";
import { runPaletteEntry } from "../palette/palette-actions";
import { fillsPanel, PaletteEntry } from "../palette/palette-model";
import { newViewFavoriteBindings } from "../shortcuts/registry";
import { readWorkspaceProject } from "../workspace-project";
import {
    newViewChoices,
    NewViewFavoritesKey,
    NewViewOpenKey,
    newViewStart,
    NewViewStart,
    resolveDirect,
    resolveFavorites,
} from "./new-view-model";

const TerminalBlockDef: BlockDef = { meta: { view: "term", controller: "shell" } };

export function currentNewViewChoices(): PaletteEntry[] {
    const fullConfig = globalStore.get(atoms.fullConfigAtom);
    const ws = globalStore.get(atoms.workspace);
    return newViewChoices({
        presets: fullConfig?.presets,
        widgets: fullConfig?.widgets,
        workspaceId: ws?.oid,
        projectLinked: readWorkspaceProject(ws).dir !== "",
    });
}

export function currentFavorites(choices: PaletteEntry[] = currentNewViewChoices()): PaletteEntry[] {
    return resolveFavorites(globalStore.get(getSettingsKeyAtom(NewViewFavoritesKey)), choices);
}

async function start(s: NewViewStart): Promise<void> {
    if (s.kind === "tab") {
        getApi().createTab(s.blockdef);
        return;
    }
    await runPaletteEntry(s.run, { placement: "new", blockId: null });
}

export function openNewView() {
    const choices = currentNewViewChoices();
    const direct = resolveDirect(globalStore.get(getSettingsKeyAtom(NewViewOpenKey)), choices);
    fireAndForget(() => start(newViewStart(direct)));
}

// ⌥⌘1…⌥⌘4: a new view already holding the favourite of that position; false when there is none.
export function openFavorite(position: number): boolean {
    const entry = currentFavorites()[position - 1];
    if (entry == null) {
        return false;
    }
    fireAndForget(() => start(newViewStart(entry)));
    return true;
}

function activeTab(): Tab {
    const tabId = globalStore.get(atoms.staticTabId);
    return tabId ? globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId))) : null;
}

// Escape in the chooser: the new view goes. Split meanwhile, only the chooser's pane goes; the workspace's only view
// keeps a terminal rather than closing the window.
export async function dismissNewView(blockId: string): Promise<void> {
    const tab = activeTab();
    const ws = globalStore.get(atoms.workspace);
    if ((tab?.blockids?.length ?? 0) > 1) {
        const layoutModel = getLayoutModelForStaticTab();
        const node = layoutModel?.getNodeByBlockId(blockId);
        if (node != null) {
            await layoutModel.closeNode(node.id);
        }
        return;
    }
    if (tab == null || ws == null || (ws.tabids?.length ?? 0) <= 1) {
        await replaceBlock(blockId, TerminalBlockDef, true);
        return;
    }
    await getApi().closeTab(ws.oid, tab.oid, false);
}

// An entry picked in the chooser fills the view; one that opens nothing in a panel (Sessions, the Project tab) runs,
// and the empty view goes.
export async function openInNewView(entry: PaletteEntry, blockId: string): Promise<void> {
    if (entry == null) {
        return;
    }
    if (fillsPanel(entry.run)) {
        await runPaletteEntry(entry.run, { placement: "replace", blockId });
        return;
    }
    await runPaletteEntry(entry.run, { placement: "new", blockId: null });
    await dismissNewView(blockId);
}

export function registerNewViewKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    newViewFavoriteBindings(isMacOS()).forEach((keys, i) => {
        keyMap.set(keys, () => openFavorite(i + 1));
    });
}
