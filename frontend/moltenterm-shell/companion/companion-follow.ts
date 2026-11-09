// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Follows a terminal's companion without showing it (#967): Mission Control's Now card lists each agent's running
// sub-agents as the companion's Agents at work does. Same calls as the companion view, under this mount's own lease:
// wavesrv reads nothing more than for an open companion, and stops with the last lease.

import { makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useEffect, useMemo, useState } from "react";
import { TabActivity, whileShown } from "../tab-activity";
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

// A follower whose lease lapsed while its view was hidden is leased anew when the view shows again, and wavesrv starts it
// at "loading" with nothing known. The list the view held stays until wavesrv has read the session again, so the
// sub-agents never flash to none on the way back (#2154).
export function followedView(current: CompanionView, next: CompanionView): CompanionView {
    if (next?.status === "loading" && current != null && current.status !== "loading") {
        return current;
    }
    return newerView(current, next);
}

// The two jobs of a follower: the lease's renewal and the refresh of the sub-agents. Both run only while the view shows
// (#2154): each lease keeps a 250 ms watcher and a transcript discovery alive in wavesrv, so a view nobody looks at lets
// its lease lapse and wavesrv stops following. A view that shows again after a pause runs both at once (the scheduler's
// resume), which leases anew and looks again, so the sub-agents it lists are the ones that work now.
export function followJobs(
    open: (refresh: boolean) => void,
    activity: Pick<TabActivity, "every"> = TabActivity.getInstance()
): () => void {
    const stopRenew = activity.every(whileShown(LeaseRenewMs), () => open(false), "companion-follow-lease");
    const stopRefresh = activity.every(whileShown(RefreshMs), () => open(true), "companion-follow");
    return () => {
        stopRenew();
        stopRefresh();
    };
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
                setView((cur) => followedView(cur, next));
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
        const stopJobs = followJobs(open);
        return () => {
            cancelled = true;
            stopJobs();
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
