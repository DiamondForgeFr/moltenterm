// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project tab's lifecycle on the window side (FR-SHELL-015): wavesrv decides and makes the tab
// (pkg/wcore/moltenterm_projecttab.go) under one lock; the window asks when it shows a workspace or its link changes,
// and when the user asks for the tab (palette, rail). A tab the user closed stays closed until they ask.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { MissionRouteId } from "../mission/mission-client";
import { readWorkspaceProject } from "../workspace-project";
import { ProjectTabCommand } from "./project-model";

const ProjectTabTimeoutMs = 15000;

export type ProjectTabResult = { tabid?: string; created?: boolean; closed?: boolean; hasview?: boolean };

export function requestProjectTab(workspaceId: string, open: boolean, activate: boolean): Promise<ProjectTabResult> {
    return TabRpcClient.wshRpcCall(
        ProjectTabCommand,
        { workspaceid: workspaceId, open, activate },
        { route: MissionRouteId, timeout: ProjectTabTimeoutMs }
    );
}

// The user asked for the Project tab of the workspace this window shows: made again if they had closed it, then shown.
export async function openProjectTab(): Promise<void> {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    const result = await requestProjectTab(ws.oid, true, false);
    if (result?.tabid) {
        getApi().setActiveTab(result.tabid);
    }
}

// Shows the Project tab of a workspace if it has one that still holds the project view, switching workspace when
// needed (wavesrv activates the tab before the window shows the workspace). Returns false otherwise: the caller falls
// back to the panel it would have opened.
export async function showProjectTab(workspaceId: string): Promise<boolean> {
    const active = globalStore.get(atoms.workspace);
    const target = workspaceId || active?.oid;
    if (!target) {
        return false;
    }
    const other = target !== active?.oid;
    const result = await requestProjectTab(target, false, other);
    if (!result?.tabid || !result.hasview) {
        return false;
    }
    if (other) {
        getApi().switchWorkspace(target);
    } else {
        getApi().setActiveTab(result.tabid);
    }
    return true;
}

// The requests in flight, by workspace and project: a window re-rendering never asks twice for the same thing.
const asking = new Set<string>();

function ensureProjectTab(workspaceId: string, dir: string) {
    const key = `${workspaceId}\n${dir}`;
    if (asking.has(key)) {
        return;
    }
    asking.add(key);
    fireAndForget(async () => {
        try {
            await requestProjectTab(workspaceId, false, false);
        } catch (e) {
            console.log("project tab:", e?.message ?? e);
        } finally {
            asking.delete(key);
        }
    });
}

// Mounted with the rail of every tab: only the tab on screen asks, so a window with many tabs sends one request. The
// workspace shown gets its Project tab when it is linked (at startup, on a link from the editor or from molten), and
// its record follows the link.
export function ProjectTabKeeper() {
    const ws = useAtomValue(atoms.workspace);
    const staticTabId = useAtomValue(atoms.staticTabId);
    const workspaceId = ws?.oid;
    const dir = readWorkspaceProject(ws).dir;
    const onScreen = staticTabId != null && staticTabId === ws?.activetabid;
    useEffect(() => {
        if (!workspaceId || !onScreen) {
            return;
        }
        ensureProjectTab(workspaceId, dir);
    }, [workspaceId, dir, onScreen]);
    return null;
}
