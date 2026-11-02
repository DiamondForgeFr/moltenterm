// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Follows a terminal's companion without showing it (#967): Mission Control's Now card lists each agent's running
// sub-agents as the companion's Agents at work does. Same calls as the companion view, under this mount's own lease:
// wavesrv reads nothing more than for an open companion, and stops with the last lease.

import { makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useEffect, useMemo, useState } from "react";
import { always, TabActivity, whileShown } from "../tab-activity";
import {
    CompanionCloseCommand,
    CompanionEvent,
    CompanionOpenCommand,
    CompanionRoute,
    CompanionView,
    newerView,
} from "./companion-model";

const RpcTimeoutMs = 5000;
// The lease wavesrv keeps a follower for is 45 s.
const LeaseRenewMs = 15000;
// Sub-agents' tickets and branches are read on a refresh: less often than an open companion, which shows more.
const RefreshMs = 20000;

function companionCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: CompanionRoute, timeout: RpcTimeoutMs });
}

export function useCompanionFollow(blockId: string): CompanionView {
    const [view, setView] = useState<CompanionView>(null);
    const viewId = useMemo(() => crypto.randomUUID(), [blockId]);
    useEffect(() => {
        setView(null);
        if (!blockId) {
            return;
        }
        let cancelled = false;
        const accept = (next: CompanionView) => {
            if (!cancelled && next?.blockid === blockId) {
                setView((cur) => newerView(cur, next));
            }
        };
        let unsubscribe = () => {};
        try {
            unsubscribe = waveEventSubscribeSingle({
                eventType: CompanionEvent as WaveEventName,
                scope: makeORef("block", blockId),
                handler: (event) => accept(event.data as CompanionView),
            });
        } catch (e) {
            console.log("companion follow: no event bus", e);
        }
        const open = (refresh: boolean) =>
            fireAndForget(async () => {
                try {
                    accept(
                        await companionCall<CompanionView>(CompanionOpenCommand, {
                            blockid: blockId,
                            viewid: viewId,
                            refresh,
                        })
                    );
                } catch {
                    // A terminal without a companion (no agent, too many followers) just lists no sub-agents.
                }
            });
        open(true);
        const stopRenew = TabActivity.getInstance().every(
            always(LeaseRenewMs),
            () => open(false),
            "companion-follow-lease"
        );
        const stopRefresh = TabActivity.getInstance().every(
            whileShown(RefreshMs),
            () => open(true),
            "companion-follow"
        );
        return () => {
            cancelled = true;
            stopRenew();
            stopRefresh();
            unsubscribe();
            fireAndForget(async () => {
                try {
                    await companionCall(CompanionCloseCommand, { blockid: blockId, viewid: viewId });
                } catch {
                    // wavesrv drops the follower when its lease ends anyway.
                }
            });
        };
    }, [blockId, viewId]);
    return view;
}
