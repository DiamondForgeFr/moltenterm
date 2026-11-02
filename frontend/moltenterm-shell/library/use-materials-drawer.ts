// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    MaterialsChanged,
    MaterialsEvent,
    MaterialsListCommand,
    MaterialsRoute,
    MaterialsView,
} from "./materials-model";
import { makeMaterialsRefresh } from "./materials-refresh";

// The drawer follows the current workspace and only publishes snapshots that have not been invalidated.
export function useMaterialsDrawer(workspaceId: string): { view: MaterialsView; failed: boolean } {
    const [state, setState] = useState<{ workspaceId: string; view: MaterialsView; failed: boolean }>({
        workspaceId,
        view: null,
        failed: false,
    });
    const view = state.workspaceId === workspaceId ? state.view : null;
    const failed = state.workspaceId === workspaceId && state.failed;
    const key = view?.project?.key ?? "";
    const refreshRef = useRef<ReturnType<typeof makeMaterialsRefresh<MaterialsView>>>(null);
    if (refreshRef.current == null) refreshRef.current = makeMaterialsRefresh<MaterialsView>();
    const refresh = refreshRef.current;
    useLayoutEffect(() => {
        setState((old) => (old.workspaceId === workspaceId ? old : { workspaceId, view: null, failed: false }));
    }, [workspaceId]);
    useEffect(() => {
        return refresh.activate(
            () =>
                TabRpcClient.wshRpcCall(
                    MaterialsListCommand,
                    { workspaceid: workspaceId },
                    { route: MaterialsRoute, timeout: 5000 }
                ),
            (next) => setState({ workspaceId, view: next ?? null, failed: false }),
            (e) => {
                console.log("library: materials", e);
                setState((old) => ({
                    workspaceId,
                    view: old.workspaceId === workspaceId ? old.view : null,
                    failed: true,
                }));
            }
        );
    }, [workspaceId, refresh]);
    useEffect(() => {
        if (!key) return;
        try {
            return waveEventSubscribeSingle({
                eventType: MaterialsEvent as WaveEventName,
                scope: key,
                handler: (event) => {
                    const data = event.data as MaterialsChanged;
                    if (data?.project && data.project !== key) return;
                    refresh.request();
                },
            });
        } catch (e) {
            console.log("library: materials, no event bus", e);
        }
    }, [key, refresh]);
    return { view, failed };
}
