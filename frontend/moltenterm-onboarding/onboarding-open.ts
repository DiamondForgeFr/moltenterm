// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Opening Getting started (app menu, command palette, notification): the workspace's panel when it has one, sent to
// the page reopening lands on; else a new panel docked on the left of the active tab.

import { atoms, createBlock, createBlockSplitHorizontally, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import { activeTabIdAtom } from "@/app/store/tab-model";
import {
    getLayoutModelForStaticTab,
    LayoutTreeActionType,
    LayoutTreeInsertNodeAction,
    newLayoutNode,
} from "@/layout/index";
import { currentOnboardingState, findOnboardingPanel, setPanelPage } from "./onboarding-client";
import { dockAction, PanelNodeSize } from "./onboarding-dock";
import { FirstRunPage, MoltentermOnboardingView, OnboardingPageMetaKey, reopenPage } from "./onboarding-state";

function focusBlock(blockId: string): boolean {
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId(blockId);
    if (node == null) {
        return false;
    }
    layoutModel.focusNode(node.id);
    return true;
}

// Docks a panel block on the left of the active tab; an empty tab simply gets it.
function dockBlock(blockId: string) {
    const layoutModel = getLayoutModelForStaticTab();
    const rootNode = layoutModel?.treeState?.rootNode;
    const newNode = newLayoutNode(undefined, PanelNodeSize, undefined, { blockId });
    if (rootNode == null) {
        const insert: LayoutTreeInsertNodeAction = {
            type: LayoutTreeActionType.InsertNode,
            node: newNode,
            magnified: false,
            focused: true,
        };
        layoutModel?.treeReducer(insert);
        return;
    }
    layoutModel.treeReducer(dockAction(rootNode.id, newNode));
}

async function dockNewPanel(page: FirstRunPage): Promise<string> {
    const blockDef: BlockDef = { meta: { view: MoltentermOnboardingView, [OnboardingPageMetaKey]: page } as MetaType };
    if (getLayoutModelForStaticTab()?.treeState?.rootNode == null) {
        return createBlock(blockDef);
    }
    const blockId = await ObjectService.CreateBlock(blockDef, { termsize: { rows: 25, cols: 80 } });
    dockBlock(blockId);
    return blockId;
}

// The workspace keeps one panel: opening again shows it rather than adding a second one.
export async function openFirstRun(): Promise<void> {
    const page = reopenPage(currentOnboardingState());
    const workspaceId = globalStore.get(atoms.workspace)?.oid;
    let found: { tabid?: string; blockid?: string } = {};
    try {
        found = await findOnboardingPanel(workspaceId);
    } catch (e) {
        console.log("first run: panel lookup failed", e?.message ?? e);
    }
    if (!found?.blockid) {
        await dockNewPanel(page);
        return;
    }
    await setPanelPage(found.blockid, page);
    if (found.tabid && found.tabid !== globalStore.get(activeTabIdAtom)) {
        getApi().setActiveTab(found.tabid);
        return;
    }
    // A panel block of this tab missing from its layout (a first-run layout cut short) is docked again.
    if (!focusBlock(found.blockid)) {
        dockBlock(found.blockid);
    }
}

// What FirstRunStepContext.openBeside does: a pane on the panel's right.
export function openBesidePanel(panelBlockId: string, blockdef: BlockDef): Promise<string> {
    return createBlockSplitHorizontally(blockdef, panelBlockId, "after");
}
