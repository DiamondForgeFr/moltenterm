// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// `molten morph design <mod-id>` (FR-MORPH-019): a local terminal asks, through wavesrv (pkg/molten/morphdesign), the
// window of its workspace to show the design's tab, as `molten review open` does for a pull request. The window makes
// the tab, or finds the one the mod already has, and shows it. Nothing opens without that command: opening a tab is the
// window's gesture, and it is answered once, by the page that is shown.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { fireAndForget } from "@/util/util";
import { t } from "../i18n/i18n";
import { showTabFromHere } from "../opener-tab";
import { morphDesignTab, MorphTabResult } from "./morph-design-client";
import { MorphDesignHandoffEvent, MorphHandoff, readMorphHandoff } from "./morph-design-model";

export type MorphOpenDeps = {
    tab: (data: { mod: string; workspaceid: string; handoffid: string; tabname: string }) => Promise<MorphTabResult>;
    showTab: (tabId: string) => void;
    tabName: (title: string) => string;
};

const DefaultDeps: MorphOpenDeps = {
    tab: morphDesignTab,
    showTab: (tabId) => showTabFromHere(tabId),
    tabName: (title) => t("morphDesign.tabName", { mod: title }),
};

const handled = new Set<string>();

// Makes or finds the design's tab and shows it; the tab's id, "" when there is no workspace to open it in.
export async function openMorphDesignTab(
    h: MorphHandoff,
    workspaceId: string,
    deps: MorphOpenDeps = DefaultDeps
): Promise<string> {
    if (!workspaceId) {
        return "";
    }
    const { tabid } = await deps.tab({
        mod: h.mod,
        workspaceid: workspaceId,
        handoffid: h.id,
        tabname: deps.tabName(h.name || h.mod),
    });
    deps.showTab(tabid);
    return tabid;
}

// Every tab of a window is a page with its own rail; only the page shown acts on a hand-off, once.
function isShownPage(): boolean {
    const workspace = globalStore.get(atoms.workspace);
    return workspace != null && workspace.activetabid === globalStore.get(atoms.staticTabId);
}

// installMorphDesignHandoff listens for the hand-offs of the window's workspace; the returned function stops it.
export function installMorphDesignHandoff(workspaceId: string): () => void {
    if (!workspaceId) {
        return () => {};
    }
    return waveEventSubscribeSingle({
        eventType: MorphDesignHandoffEvent as WaveEventName,
        scope: workspaceId,
        handler: (event) => {
            const h = readMorphHandoff(event.data);
            if (h == null || handled.has(h.id) || !isShownPage()) {
                return;
            }
            handled.add(h.id);
            fireAndForget(async () => {
                try {
                    await openMorphDesignTab(h, workspaceId);
                } catch (e) {
                    console.log("morph design: the tab was not opened", h.mod, e);
                }
            });
        },
    });
}
