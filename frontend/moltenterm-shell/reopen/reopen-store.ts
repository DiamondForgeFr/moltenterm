// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The windows' side of reopening (#512): before a pane or a tab closes, wavesrv reads and keeps it
// (pkg/molten/reopen); Cmd+Shift+T asks for the last one back and says what came back.

import { atoms, getApi, globalStore } from "@/app/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { isMacOS } from "@/util/platformutil";
import { fireAndForget } from "@/util/util";
import { t } from "../i18n/i18n";
import { showToast } from "../toast-store";
import { showReopenedPanel } from "../view360/carpet-reopen";
import {
    PutAwayView,
    ReopenDropCommand,
    ReopenIdCommand,
    ReopenLastCommand,
    ReopenListCommand,
    ReopenRecordCommand,
    ReopenResult,
    ReopenRoute,
    reopenToast,
} from "./reopen-model";

// A close waits for its record at most this long: a slow wavesrv loses the record, never the close.
const RecordTimeoutMs = 1500;
const ReopenTimeoutMs = 5000;

// The tab's live layout tree when this window shows it: the stored one lags behind closes made in a quick series.
function liveRoot(tabId: string): unknown {
    if (tabId !== globalStore.get(atoms.staticTabId)) {
        return undefined;
    }
    return getLayoutModelForStaticTab()?.treeState?.rootNode ?? undefined;
}

async function record(data: Record<string, unknown>): Promise<string> {
    try {
        const res: { id: string } = await TabRpcClient.wshRpcCall(ReopenRecordCommand, data, {
            route: ReopenRoute,
            timeout: RecordTimeoutMs,
        });
        return res?.id ?? null;
    } catch (e) {
        console.log("reopen: the close was not recorded", e);
        return null;
    }
}

// Before a pane of the tab shown closes.
export function recordPaneClose(blockId: string): Promise<string> {
    const workspaceid = globalStore.get(atoms.workspaceId);
    const tabid = globalStore.get(atoms.staticTabId);
    if (!blockId || !workspaceid || !tabid) {
        return Promise.resolve(null);
    }
    return record({ kind: "pane", workspaceid, tabid, blockid: blockId, root: liveRoot(tabid) });
}

type CloseTabFn = (workspaceId: string, tabId: string, confirmClose: boolean) => Promise<boolean>;

// Wraps a tab close: the tab is recorded first, and its record goes again when the close does not happen (Electron's
// own confirmation declined).
export function recordingTabClose(closeTab: CloseTabFn): CloseTabFn {
    return async (workspaceId, tabId, confirmClose) => {
        const id = await record({ kind: "tab", workspaceid: workspaceId, tabid: tabId, root: liveRoot(tabId) });
        const closed = await closeTab(workspaceId, tabId, confirmClose);
        if (!closed && id) {
            TabRpcClient.wshRpcCall(
                ReopenDropCommand,
                { workspaceid: workspaceId, id },
                { route: ReopenRoute, timeout: RecordTimeoutMs }
            ).catch((e) => console.log("reopen: the record of a tab kept open stays", e));
        }
        return closed;
    };
}

// The keys of reopenLastClosed: Cmd+Shift+T (Alt+Shift+T off macOS, as Cmd+T is Alt+T there), and Ctrl+Shift+T off
// macOS, the browsers' key.
export function reopenKeys(): string[] {
    return isMacOS() ? ["Cmd:Shift:t"] : ["Cmd:Shift:t", "Ctrl:Shift:t"];
}

let reopening = false;

// A pane that came back on the 360 carpet is shown and focused (FR-SHELL-126-AC4): wavesrv queues its layout action,
// so the layout may lay it a moment after the answer.
const ShowReopenedTries = 50;
const ShowReopenedStepMs = 100;

async function showReopenedPane(res: ReopenResult): Promise<void> {
    if (!res?.reopened || res.kind !== "pane" || res.tabid !== globalStore.get(atoms.staticTabId)) {
        return;
    }
    for (let i = 0; i < ShowReopenedTries; i++) {
        if (showReopenedPanel(getLayoutModelForStaticTab(), res.blockid) !== "pending") {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, ShowReopenedStepMs));
    }
}

// Brings the workspace's last close back without a toast of its own: an Undo of several closes says it once.
export function reopenLastQuietly(): Promise<ReopenResult> {
    return TabRpcClient.wshRpcCall(
        ReopenLastCommand,
        { workspaceid: globalStore.get(atoms.workspaceId), tabid: globalStore.get(atoms.staticTabId) },
        { route: ReopenRoute, timeout: ReopenTimeoutMs }
    );
}

// The closed views of every workspace, the most recent first (FR-SHELL-088).
export async function listPutAwayViews(): Promise<PutAwayView[]> {
    const res: { views: PutAwayView[] } = await TabRpcClient.wshRpcCall(
        ReopenListCommand,
        {},
        { route: ReopenRoute, timeout: ReopenTimeoutMs }
    );
    return res?.views ?? [];
}

// Brings one closed view back in its own workspace, then shows that workspace. An agent that ran in it starts again
// once its terminal shows (agent-slot.tsx).
export async function reopenPutAwayView(view: PutAwayView): Promise<ReopenResult> {
    const here = globalStore.get(atoms.workspaceId);
    const res: ReopenResult = await TabRpcClient.wshRpcCall(
        ReopenIdCommand,
        {
            workspaceid: view.workspaceid,
            id: view.id,
            tabid: view.workspaceid === here ? globalStore.get(atoms.staticTabId) : "",
        },
        { route: ReopenRoute, timeout: ReopenTimeoutMs }
    );
    if (res?.reopened && view.workspaceid !== here) {
        getApi().switchWorkspace(view.workspaceid);
    }
    return res;
}

// Cmd+Shift+T: the workspace's last close comes back; pressed again, the one before.
export async function reopenLastClosed(): Promise<void> {
    if (reopening) {
        return;
    }
    reopening = true;
    try {
        const res: ReopenResult = await TabRpcClient.wshRpcCall(
            ReopenLastCommand,
            { workspaceid: globalStore.get(atoms.workspaceId), tabid: globalStore.get(atoms.staticTabId) },
            { route: ReopenRoute, timeout: ReopenTimeoutMs }
        );
        showToast(reopenToast(res, getApi().getHomeDir()));
        fireAndForget(() => showReopenedPane(res));
    } catch (e) {
        showToast({
            kind: "error",
            title: t("reopen.failed"),
            message: String(e?.message ?? e),
        });
    } finally {
        reopening = false;
    }
}
