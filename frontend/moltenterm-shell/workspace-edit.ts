// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// One open request for the workspace edit sheet (DS-SHELL-035). Every entry point (the rail's context menu, pencil and
// double-click, the command palette, the app menu, Wave's switcher) calls openWorkspaceEditor; WorkspaceEditHost, in
// the rail, shows the sheet for the request.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import {
    DoubleClickMs,
    IntentMaxAgeMs,
    isFreshIntent,
    parseIntent,
    WorkspaceEditIntentKey,
    WorkspaceSwitchClickKey,
} from "./workspace-edit-model";
import { isSavedWorkspace } from "./workspace-rail-model";

// The workspace sheet, or the Project sheet of one of its projects (FR-SHELL-105); both are shown by the same host.
export type WorkspaceSheetKind = "workspace" | "project";

export type WorkspaceEditRequest = {
    workspaceId: string;
    // Gets the focus back when the sheet closes (NFR-SHELL-014).
    opener: HTMLElement;
    sheet?: WorkspaceSheetKind;
    // The project the Project sheet shows; none shows the current one.
    projectId?: string;
};

export function sameSheet(a: WorkspaceEditRequest, b: Omit<WorkspaceEditRequest, "opener">): boolean {
    return (
        a != null &&
        b != null &&
        a.workspaceId === b.workspaceId &&
        (a.sheet ?? "workspace") === (b.sheet ?? "workspace") &&
        (a.projectId ?? "") === (b.projectId ?? "")
    );
}

// MoltenTerm's own preload function (emain/preload.ts), typed here so custom.d.ts stays Wave's.
type MoltentermWorkspaceMenuApi = {
    onMoltentermEditWorkspace?: (callback: (workspaceId?: string) => void) => void;
};

function focusedElement(): HTMLElement {
    if (typeof document === "undefined") {
        return null;
    }
    const el = document.activeElement as HTMLElement;
    return el != null && el !== document.body ? el : null;
}

export class WorkspaceEditModel {
    private static instance: WorkspaceEditModel = null;

    requestAtom = atom(null) as PrimitiveAtom<WorkspaceEditRequest>;

    private constructor() {}

    static getInstance(): WorkspaceEditModel {
        if (!WorkspaceEditModel.instance) {
            WorkspaceEditModel.instance = new WorkspaceEditModel();
        }
        return WorkspaceEditModel.instance;
    }

    static resetInstance(): void {
        WorkspaceEditModel.instance = null;
    }

    // An unsaved workspace is saved first, with Wave's default name and icon, as the rail's click does: only a saved
    // workspace has a name to edit.
    async open(
        workspaceId: string,
        opener: HTMLElement,
        target?: { sheet?: WorkspaceSheetKind; projectId?: string }
    ): Promise<boolean> {
        if (!workspaceId) {
            return false;
        }
        const wanted = { workspaceId, sheet: target?.sheet ?? "workspace", projectId: target?.projectId };
        const current = globalStore.get(this.requestAtom);
        if (sameSheet(current, wanted)) {
            return true;
        }
        // Going from one sheet to the other keeps what first opened them, which gets the focus back at the end.
        if (current?.workspaceId === workspaceId) {
            globalStore.set(this.requestAtom, { ...wanted, opener: current.opener ?? opener });
            return true;
        }
        const ws = await WorkspaceService.GetWorkspace(workspaceId);
        if (ws == null) {
            return false;
        }
        if (!isSavedWorkspace(ws)) {
            await WorkspaceService.UpdateWorkspace(workspaceId, "", "", "", true);
        }
        // The sheet writes through the object atom, which must exist first (Wave's switcher does the same).
        globalStore.get(getWaveObjectAtom(makeORef("workspace", workspaceId)));
        globalStore.set(this.requestAtom, { ...wanted, opener });
        return true;
    }

    close(): void {
        const request = globalStore.get(this.requestAtom);
        globalStore.set(this.requestAtom, null);
        const opener = request?.opener;
        if (opener == null) {
            return;
        }
        // After the sheet is gone: while it is mounted, its focus trap takes the focus back.
        setTimeout(() => {
            if (opener.isConnected) {
                opener.focus();
            }
        }, 0);
    }
}

export function openWorkspaceEditor(workspaceId: string, opener?: HTMLElement): void {
    const from = opener ?? focusedElement();
    fireAndForget(() => WorkspaceEditModel.getInstance().open(workspaceId, from));
}

// The palette and the app menu act on the workspace the window shows.
export function openCurrentWorkspaceEditor(opener?: HTMLElement): void {
    openWorkspaceEditor(globalStore.get(atoms.workspace)?.oid, opener);
}

// The Project sheet (FR-SHELL-105): the workspace sheet's Projects block, the Project panel and the "Edit <project>…"
// entries open it. Without a workspace, the window's; without a project, its current one.
export function openProjectSheet(projectId?: string, opener?: HTMLElement, workspaceId?: string): void {
    const from = opener ?? focusedElement();
    const id = workspaceId ?? globalStore.get(atoms.workspace)?.oid;
    fireAndForget(() => WorkspaceEditModel.getInstance().open(id, from, { sheet: "project", projectId }));
}

function readStorage(key: string): string {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStorage(key: string, value: string) {
    try {
        if (value == null) {
            window.localStorage.removeItem(key);
        } else {
            window.localStorage.setItem(key, value);
        }
    } catch {
        // Without storage, a double-click across a switch only switches.
    }
}

// The rail's click that switches to another workspace: the next click, in the tab view of that workspace, may be the
// second of a double-click.
export function recordSwitchClick(workspaceId: string): void {
    writeStorage(WorkspaceSwitchClickKey, JSON.stringify({ workspaceId, at: Date.now() }));
}

export function takeSwitchClick(workspaceId: string): boolean {
    const fresh = isFreshIntent(
        parseIntent(readStorage(WorkspaceSwitchClickKey)),
        workspaceId,
        Date.now(),
        DoubleClickMs
    );
    if (fresh) {
        writeStorage(WorkspaceSwitchClickKey, null);
    }
    return fresh;
}

// A double-click seen by the tab view that is being switched away from: the one that shows the workspace opens it.
export function handOverWorkspaceEdit(workspaceId: string): void {
    writeStorage(WorkspaceEditIntentKey, JSON.stringify({ workspaceId, at: Date.now() }));
}

function showsWorkspace(workspaceId: string): boolean {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid !== workspaceId) {
        return false;
    }
    // Every tab of the workspace has its own renderer; only the active one is on screen.
    return !ws.activetabid || ws.activetabid === globalStore.get(atoms.staticTabId);
}

// Opens the sheet for a handed-over double-click meant for the workspace this tab view shows.
export function pickUpWorkspaceEdit(): boolean {
    const intent = parseIntent(readStorage(WorkspaceEditIntentKey));
    const workspaceId = intent?.workspaceId;
    if (!isFreshIntent(intent, workspaceId, Date.now(), IntentMaxAgeMs) || !showsWorkspace(workspaceId)) {
        return false;
    }
    writeStorage(WorkspaceEditIntentKey, null);
    openWorkspaceEditor(workspaceId, null);
    return true;
}

// A workspace just created (#743): handed over like a double-click, so the tab view that shows it opens the sheet, here
// or in another view once it has taken the workspace over.
export function editNewWorkspace(workspaceId: string): void {
    handOverWorkspaceEdit(workspaceId);
    pickUpWorkspaceEdit();
}

let menuListening = false;

// The app menu's Workspace › Edit Workspace… (emain/moltenterm-workspace-menu.ts) reaches the active tab's renderer
// without a workspace; a workspace just created comes with its id.
export function listenWorkspaceMenu(): void {
    if (menuListening) {
        return;
    }
    menuListening = true;
    (getApi() as unknown as MoltentermWorkspaceMenuApi)?.onMoltentermEditWorkspace?.((workspaceId) => {
        if (workspaceId) {
            editNewWorkspace(workspaceId);
            return;
        }
        openCurrentWorkspaceEditor();
    });
}
