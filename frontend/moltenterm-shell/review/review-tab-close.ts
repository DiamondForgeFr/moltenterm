// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { deleteLayoutModelForTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { closeTabAskingFirst } from "../worktree-close";

// closeThisTab closes the Review tab of this page from its Validate sheet (#686), through the same path as the tab's own
// close (its panels' guards included).
export function closeThisTab() {
    const workspaceId = globalStore.get(atoms.workspaceId);
    const tabId = globalStore.get(atoms.staticTabId);
    fireAndForget(async () => {
        if (await closeTabAskingFirst(getApi().closeTab, workspaceId, tabId, false)) {
            deleteLayoutModelForTab(tabId);
        }
    });
}
