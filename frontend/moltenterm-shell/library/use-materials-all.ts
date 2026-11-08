// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useEffect, useRef, useState } from "react";
import {
    MaterialsAllScope,
    MaterialsEvent,
    MaterialsListCommand,
    MaterialsNoProject,
    MaterialsProject,
    MaterialsRoute,
    MaterialsScope,
    MaterialsView,
} from "./materials-model";
import { makeMaterialsRefresh } from "./materials-refresh";

// Project counts refresh independently so a scope-menu update never stats or decorates unrelated originals.
function useMaterialsList(
    workspaceId: string,
    projectDir: string,
    key: string,
    data: Record<string, unknown>,
    eventScope: string
): MaterialsView {
    const [state, setState] = useState<{ key: string; view: MaterialsView }>({ key: "", view: null });
    const refreshRef = useRef<ReturnType<typeof makeMaterialsRefresh<MaterialsView>>>(null);
    if (refreshRef.current == null) refreshRef.current = makeMaterialsRefresh<MaterialsView>();
    const refresh = refreshRef.current;
    useEffect(() => {
        if (!workspaceId || !key) return;
        return refresh.activate(
            () => TabRpcClient.wshRpcCall(MaterialsListCommand, data, { route: MaterialsRoute, timeout: 5000 }),
            (next) => setState({ key, view: next ?? null }),
            (e) => console.log("library: materials of every project", e)
        );
    }, [workspaceId, projectDir, key, refresh]);
    useEffect(() => {
        if (!workspaceId || !key || !eventScope) return;
        try {
            return waveEventSubscribeSingle({
                eventType: MaterialsEvent as WaveEventName,
                scope: eventScope,
                handler: () => refresh.request(),
            });
        } catch (e) {
            console.log("library: materials, no event bus", e);
        }
    }, [workspaceId, key, eventScope, refresh]);
    return state.key === key ? state.view : null;
}

export function useMaterialsProjects(workspaceId: string, projectDir: string): MaterialsProject[] {
    return useMaterialsList(
        workspaceId,
        projectDir,
        `summary:${workspaceId}:${projectDir}`,
        { workspaceid: workspaceId, summary: true },
        MaterialsAllScope
    )?.projects;
}

export function materialsScopeRequest(workspaceId: string, scope: MaterialsScope): Record<string, unknown> {
    if (scope.kind === "active") return null;
    if (scope.kind === "all") return { workspaceid: workspaceId, all: true };
    return { workspaceid: workspaceId, project: scope.kind === "none" ? MaterialsNoProject : scope.key };
}

export function useMaterialsScope(workspaceId: string, projectDir: string, scope: MaterialsScope): MaterialsView {
    const data = materialsScopeRequest(workspaceId, scope);
    const project = scope.kind === "project" ? scope.key : scope.kind === "none" ? MaterialsNoProject : "";
    return useMaterialsList(
        workspaceId,
        projectDir,
        data ? `${workspaceId}:${projectDir}:${scope.kind}:${project}` : "",
        data,
        scope.kind === "all" ? MaterialsAllScope : project
    );
}
