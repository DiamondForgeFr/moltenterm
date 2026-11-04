// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// `molten morph design <mod-id>` (FR-MORPH-019): wavesrv (pkg/molten/morphdesign) puts the design's panel to the right of
// the calling agent's terminal, in that terminal's tab, and needs no window for it. Two things stay the window's
// gesture, asked as `molten review open` asks for a pull request's tab: a second call brings the open panel into view
// (kind focus), and a design whose panel could not go beside the terminal gets a tab of its own, which the window makes
// or finds and shows (kind tab). Nothing opens without that command, and a hand-off is answered once, by the page that
// is shown.

import { atoms, refocusNode } from "@/app/store/global";
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

export type MorphFocusDeps = {
    shownTab: () => string;
    showTab: (tabId: string) => void;
    focusBlock: (blockId: string) => void;
};

const DefaultFocusDeps: MorphFocusDeps = {
    shownTab: () => globalStore.get(atoms.staticTabId),
    showTab: (tabId) => showTabFromHere(tabId),
    // The panel's own block takes the focus back while the call that asked is handled: the next frame.
    focusBlock: (blockId) => requestAnimationFrame(() => refocusNode(blockId)),
};

const handled = new Set<string>();

// Brings an open panel into view and gives it the keyboard; a panel in another tab only has its tab shown (the keyboard
// goes to the node of the page that is shown, which is not the panel's).
export function focusMorphDesignPanel(h: MorphHandoff, deps: MorphFocusDeps = DefaultFocusDeps): void {
    if (!h.tabid || !h.blockid) {
        return;
    }
    if (deps.shownTab() !== h.tabid) {
        deps.showTab(h.tabid);
        return;
    }
    deps.focusBlock(h.blockid);
}

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
            if (h.kind === "focus") {
                focusMorphDesignPanel(h);
                return;
            }
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
