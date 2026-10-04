// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Opening and closing the agent companion (FR-SHELL-018): a block docked to the right of its terminal, closed by
// default, toggled by the agent label of the pane header or Cmd+Shift+J. The terminal keeps the focus: the agent is
// still where the user types.

import { createBlockSplitHorizontally } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { uxCloseBlock } from "@/app/store/keymodel";
import { getActiveTabModel } from "@/app/store/tab-model";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { openFileInPreview } from "../term-copy/term-copy";
import { CompanionTargetMetaKey, MoltentermCompanionView } from "./companion-model";

export const CompanionKey = "Cmd:Shift:j";

function blockMeta(blockId: string): MetaType {
    return globalStore.get(getWaveObjectAtom<Block>(makeORef("block", blockId)))?.meta;
}

function activeTabBlockIds(): string[] {
    const tabAtom = getActiveTabModel()?.tabAtom;
    const tab = tabAtom == null ? null : globalStore.get(tabAtom);
    return tab?.blockids ?? [];
}

// The companion block of a terminal in the active tab, if one is open.
export function findCompanionBlock(terminalBlockId: string): string {
    for (const blockId of activeTabBlockIds()) {
        const meta = blockMeta(blockId);
        if (meta?.view === MoltentermCompanionView && meta?.[CompanionTargetMetaKey] === terminalBlockId) {
            return blockId;
        }
    }
    return null;
}

function focusBlock(blockId: string) {
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId(blockId);
    if (node != null) {
        layoutModel.focusNode(node.id);
    }
}

export async function toggleCompanion(terminalBlockId: string): Promise<void> {
    if (!terminalBlockId) {
        return;
    }
    const existing = findCompanionBlock(terminalBlockId);
    if (existing) {
        uxCloseBlock(existing);
        return;
    }
    const blockDef: BlockDef = {
        meta: { view: MoltentermCompanionView, [CompanionTargetMetaKey]: terminalBlockId } as MetaType,
    };
    await createBlockSplitHorizontally(blockDef, terminalBlockId, "after");
    focusBlock(terminalBlockId);
}

// The shortcut works from the terminal and from its companion.
function toggleFocusedCompanion(): boolean {
    const layoutModel = getLayoutModelForStaticTab();
    const focused = layoutModel == null ? null : globalStore.get(layoutModel.focusedNode)?.data?.blockId;
    if (!focused) {
        return false;
    }
    const meta = blockMeta(focused);
    if (meta?.view === MoltentermCompanionView) {
        uxCloseBlock(focused);
        const target = meta[CompanionTargetMetaKey];
        if (target) {
            focusBlock(target);
        }
        return true;
    }
    if (meta?.view !== "term") {
        return false;
    }
    fireAndForget(() => toggleCompanion(focused));
    return true;
}

export function registerCompanionKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    keyMap.set(CompanionKey, () => toggleFocusedCompanion());
}

// Opens a file the agent changed in the preview next to the companion, at the line its first change starts, with
// the terminal file links' helper (FR-SHELL-017): a preview of the same file in the tab is reused.
export function openChangedFile(path: string, line: number, companionBlockId: string) {
    fireAndForget(() => openFileInPreview({ path, line: line > 0 ? line : undefined, conn: "" }, companionBlockId));
}
