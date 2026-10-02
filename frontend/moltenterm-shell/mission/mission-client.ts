// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The panels' side of Mission Control's collector (DS-MC-001): they ask wavesrv, show the cached answer at once, and
// take the refreshed snapshot from the event bus. Panels poll slowly, and only while the window is visible.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useCallback, useEffect, useState } from "react";
import { MissionSnapshot } from "./mission-model";

// must match the names in pkg/molten/mission/collector.go
export const MissionRouteId = "molten:mission";
export const MissionGetCommand = "moltenmissionget";
export const MissionRefreshCommand = "moltenmissionrefresh";
export const MissionUpdateEvent = "molten:mission:update";

const MissionRpcTimeoutMs = 15000;
const MissionPollMs = 60000;

export function missionGet(dir: string, maxAgeSec?: number): Promise<MissionSnapshot> {
    return TabRpcClient.wshRpcCall(
        MissionGetCommand,
        { dir, maxagesec: maxAgeSec },
        { route: MissionRouteId, timeout: MissionRpcTimeoutMs }
    );
}

export function missionRefresh(dir: string): Promise<MissionSnapshot> {
    return TabRpcClient.wshRpcCall(
        MissionRefreshCommand,
        { dir },
        { route: MissionRouteId, timeout: MissionRpcTimeoutMs }
    );
}

export type MissionState = {
    snapshot: MissionSnapshot;
    error: string;
    refresh: () => void;
};

export function useMissionSnapshot(dir: string): MissionState {
    const [snapshot, setSnapshot] = useState<MissionSnapshot>(null);
    const [error, setError] = useState<string>(null);
    const ask = useCallback(
        (fn: (dir: string) => Promise<MissionSnapshot>) => {
            if (!dir) {
                return;
            }
            fireAndForget(async () => {
                try {
                    const snap = await fn(dir);
                    if (snap?.dir === dir) {
                        setSnapshot(snap);
                        setError(null);
                    }
                } catch (e) {
                    setError(String(e?.message ?? e));
                }
            });
        },
        [dir]
    );
    useEffect(() => {
        setSnapshot(null);
        setError(null);
        if (!dir) {
            return;
        }
        const unsubscribe = waveEventSubscribeSingle({
            eventType: MissionUpdateEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const snap = event.data as MissionSnapshot;
                if (snap?.dir === dir) {
                    setSnapshot(snap);
                }
            },
        });
        ask((d) => missionGet(d));
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") {
                ask((d) => missionGet(d));
            }
        }, MissionPollMs);
        return () => {
            unsubscribe();
            clearInterval(timer);
        };
    }, [dir, ask]);
    const refresh = useCallback(() => ask(missionRefresh), [ask]);
    return { snapshot, error, refresh };
}
