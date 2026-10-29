// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Resetting or deleting a workspace (#222, FR-SHELL-095): every entry point (the sidebar, the rail, the workspace
// editor, Wave's workspace switcher) asks in this one dialog. It names what is lost, what runs in its terminals
// included (FR-SHELL-061, #489: then Cancel is focused), and says the "only workspace" subtitle only for the last one.
// Electron then resets or deletes the workspace in the window that shows it (emain/emain-window.ts, "reset-workspace"
// and "delete-workspace"), keeping a snapshot first; the window's renderer shown afterwards offers Undo in a toast for
// the time wavesrv keeps it (WorkspaceUndoHost).

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService, WorkspaceService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { RunningList } from "./busy-close";
import { RunningItem } from "./busy-close-model";
import { busyCloseEnabled, readWorkspaceRunning } from "./busy-close-store";
import { DialogFrame } from "./dialog-frame";
import { t, useT } from "./i18n/i18n";
import { dismissToast, showToast } from "./toast-store";
import { workspaceShownName } from "./workspace-default-name";
import {
    resetLossText,
    WorkspaceActionKind,
    workspaceDialogKeys,
    workspaceUndoToast,
    WorkspaceUndoToastId,
} from "./workspace-reset-model";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";
// Calm and red-bordered, without the molten wave: only molten actions carry it (#1318, decision 9).
const DangerButton =
    "cursor-pointer rounded-6 border border-error/60 px-3 py-1.5 text-12 text-danger hover:border-error hover:bg-error/10";

type WorkspaceActionRequest = {
    kind: WorkspaceActionKind;
    workspaceId: string;
    name: string;
    last: boolean;
    tabCount: number;
    paneCount: number;
    running: RunningItem[];
};

const RequestAtom = atom(null) as PrimitiveAtom<WorkspaceActionRequest>;

async function countPanes(tabIds: string[]): Promise<number> {
    if (tabIds.length === 0) {
        return 0;
    }
    const tabs = (await ObjectService.GetObjects(tabIds.map((id) => makeORef("tab", id)))) as Tab[];
    return (tabs ?? []).reduce((n, tab) => n + (tab?.blockids?.length ?? 0), 0);
}

async function isLastWorkspace(workspaceId: string): Promise<boolean> {
    try {
        return !(await WorkspaceService.CanCloseWorkspace(workspaceId));
    } catch (e) {
        console.log("can the workspace close", e);
        return false;
    }
}

async function readWorkspaceAction(kind: WorkspaceActionKind, workspaceId: string): Promise<WorkspaceActionRequest> {
    const ws = await WorkspaceService.GetWorkspace(workspaceId);
    if (ws == null) {
        return null;
    }
    const tabIds = ws.tabids ?? [];
    let paneCount = 0;
    try {
        paneCount = await countPanes(tabIds);
    } catch (e) {
        console.log("panes of the workspace", e);
    }
    const name = workspaceShownName(ws.name, t) || t("workspace.reset.unsaved");
    const last = await isLastWorkspace(workspaceId);
    const running = busyCloseEnabled() ? await readWorkspaceRunning(workspaceId, name) : [];
    // The last workspace of a window is reset, never deleted: a stale menu that still offers Delete asks to reset.
    return {
        kind: kind === "delete" && last ? "reset" : kind,
        workspaceId,
        name,
        last,
        tabCount: tabIds.length,
        paneCount,
        running,
    };
}

// Resolves once the dialog is open (or the workspace was not found).
async function askWorkspaceAction(kind: WorkspaceActionKind, workspaceId: string): Promise<void> {
    try {
        const request = await readWorkspaceAction(kind, workspaceId);
        if (request != null) {
            globalStore.set(RequestAtom, request);
        }
    } catch (e) {
        console.log("asking to", kind, "the workspace", e);
    }
}

export function askResetWorkspace(workspaceId: string): Promise<void> {
    return askWorkspaceAction("reset", workspaceId);
}

export function askDeleteWorkspace(workspaceId: string): Promise<void> {
    return askWorkspaceAction("delete", workspaceId);
}

export function WorkspaceResetHost() {
    const request = useAtomValue(RequestAtom);
    const t = useT();
    const cancel = () => globalStore.set(RequestAtom, null);
    if (request == null) {
        return null;
    }
    const keys = workspaceDialogKeys(request.kind);
    const confirm = () => {
        globalStore.set(RequestAtom, null);
        if (request.kind === "delete") {
            getApi().deleteWorkspace(request.workspaceId);
            return;
        }
        getApi().resetWorkspace(request.workspaceId);
    };
    const busy = request.running.length > 0;
    return (
        <DialogFrame
            role={`workspace-${request.kind}`}
            onEscape={cancel}
            title={t(keys.title, { name: request.name })}
            subtitle={request.last ? t("workspace.reset.subtitle") : undefined}
            subtitleWraps
            buttons={
                <>
                    <button type="button" className={PlainButton} onClick={cancel} autoFocus={busy}>
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className={DangerButton}
                        data-action={request.kind}
                        onClick={confirm}
                        autoFocus={!busy}
                    >
                        {t(keys.button)}
                    </button>
                </>
            }
        >
            <p>{resetLossText(request.tabCount, request.paneCount)}</p>
            <RunningList items={request.running} heading={t(keys.stops)} />
            {request.kind === "reset" && <p className="text-secondary">{t("workspace.reset.kept")}</p>}
            <p className="text-secondary">{t("workspace.reset.undoNote")}</p>
        </DialogFrame>
    );
}

function windowId(): string {
    return globalStore.get(atoms.uiContext)?.windowid ?? "";
}

// Views of other workspaces stay alive hidden (#68): only the view the window shows offers the undo.
function showsWindowView(): boolean {
    const ws = globalStore.get(atoms.workspace);
    if (ws == null || ws.activetabid !== globalStore.get(atoms.staticTabId)) {
        return false;
    }
    const win = WOS.getObjectValue<WaveWindow>(WOS.makeORef("window", windowId()));
    return win == null || win.workspaceid === ws.oid;
}

// The undo shown is the one wavesrv still keeps for this window; one this renderer already shows is not shown again.
let shownUndoId: string = null;

async function offerUndo() {
    const wid = windowId();
    if (!wid || !showsWindowView()) {
        return;
    }
    const offer = await WorkspaceService.PendingWorkspaceUndo(wid);
    if (offer == null || offer.undoid === shownUndoId || offer.remainingms <= 0) {
        return;
    }
    shownUndoId = offer.undoid;
    showToast(workspaceUndoToast(offer, () => undo(offer)));
}

async function undo(offer: WorkspaceUndoOffer) {
    // Pointing at the toast pauses it, wavesrv's offer does not: a late click says so instead of doing nothing.
    const still = await WorkspaceService.PendingWorkspaceUndo(windowId()).catch((): WorkspaceUndoOffer => null);
    dismissToast(WorkspaceUndoToastId);
    if (still?.undoid !== offer.undoid) {
        showToast({ kind: "info", title: t("workspace.reset.tooLate") });
        return;
    }
    getApi().undoWorkspace(offer.undoid, offer.workspaceid);
}

// Mounted once per renderer with the other workspace hosts: the renderer on screen after a reset or a delete is a new
// view, so the offer is read when it mounts and whenever the workspaces change.
export function WorkspaceUndoHost() {
    const ws = useAtomValue(atoms.workspace);
    // The view's workspace may load after it mounts.
    useEffect(() => {
        fireAndForget(offerUndo);
    }, [ws?.oid, ws?.activetabid]);
    useEffect(() => {
        return waveEventSubscribeSingle({
            eventType: "workspace:update",
            handler: () => fireAndForget(offerUndo),
        });
    }, []);
    return null;
}
