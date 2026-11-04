// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useEffect, useRef, useState } from "react";
import {
    MaterialsAllScope,
    MaterialsEvent,
    MaterialsListCommand,
    MaterialsRoute,
    MaterialsView,
} from "./materials-model";
import { makeMaterialsRefresh } from "./materials-refresh";

// The materials of every project (#1816), kept current by the registry's event under its all-projects scope: the
// Materials section lists by project from this; the workspace's own drawer comes first, in `project`. Linking another
// project to the workspace reads the list again, as it does for the workspace's drawer.
export function useMaterialsAllProjects(workspaceId: string, projectDir: string): MaterialsView {
    const [state, setState] = useState<{ workspaceId: string; view: MaterialsView }>({ workspaceId, view: null });
    const refreshRef = useRef<ReturnType<typeof makeMaterialsRefresh<MaterialsView>>>(null);
    if (refreshRef.current == null) refreshRef.current = makeMaterialsRefresh<MaterialsView>();
    const refresh = refreshRef.current;
    useEffect(() => {
        if (!workspaceId) return;
        return refresh.activate(
            () =>
                TabRpcClient.wshRpcCall(
                    MaterialsListCommand,
                    { workspaceid: workspaceId, all: true },
                    { route: MaterialsRoute, timeout: 5000 }
                ),
            (next) => setState({ workspaceId, view: next ?? null }),
            (e) => console.log("library: materials of every project", e)
        );
    }, [workspaceId, projectDir, refresh]);
    useEffect(() => {
        try {
            return waveEventSubscribeSingle({
                eventType: MaterialsEvent as WaveEventName,
                scope: MaterialsAllScope,
                handler: () => refresh.request(),
            });
        } catch (e) {
            console.log("library: materials, no event bus", e);
        }
    }, [refresh]);
    return state.workspaceId === workspaceId ? state.view : null;
}
