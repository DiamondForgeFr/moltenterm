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

export type ProjectTabResult = { tabid?: string; created?: boolean; closed?: boolean };

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

// Shows the Project tab of a workspace if it has one, switching workspace when needed (wavesrv activates the tab
// before the window shows the workspace). Returns false when the workspace has none: the caller falls back.
export async function showProjectTab(workspaceId: string): Promise<boolean> {
    const active = globalStore.get(atoms.workspace);
    const target = workspaceId || active?.oid;
    if (!target) {
        return false;
    }
    const other = target !== active?.oid;
    const result = await requestProjectTab(target, false, other);
    if (!result?.tabid) {
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

// Mounted once per window: the workspace shown gets its Project tab when it is linked (at startup, on a link from the
// editor or from molten), and its record is cleared when it is unlinked.
export function ProjectTabKeeper() {
    const ws = useAtomValue(atoms.workspace);
    const workspaceId = ws?.oid;
    const dir = readWorkspaceProject(ws).dir;
    useEffect(() => {
        if (!workspaceId) {
            return;
        }
        ensureProjectTab(workspaceId, dir);
    }, [workspaceId, dir]);
    return null;
}
