// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What runs now, for the notification center (FR-MC-019): the builds, release and adapter steps and local CI runs of
// every project (pkg/molten/mission/work.go), and the gold update while it is applied. Kept current by the run and CI
// events of every project.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { ciCancel, missionCancel, MissionCiEvent, MissionRouteId, MissionRunEvent } from "./mission/mission-client";
import { GoldUpdateModel } from "./update/update-store";

// must match WorkItem in pkg/molten/mission/work.go
export type WorkItem = {
    id: string;
    kind: string;
    dir: string;
    title: string;
    detail?: string;
    startedat: number;
    // From 0 to 1, or -1 when the work does not say.
    progress: number;
};

export const WorkCommand = "moltenmissionwork";
export const UpdateWorkId = "gold-update";

const WorkRefreshDelayMs = 300;
const WorkPollMs = 3000;
const IdlePollMs = 30000;

// The progress the bell's ring shows: the mean of the measured work, or null when none is measured.
export function overallProgress(items: WorkItem[]): number {
    const measured = items.filter((i) => i.progress >= 0);
    if (measured.length === 0) {
        return null;
    }
    return measured.reduce((sum, i) => sum + i.progress, 0) / measured.length;
}

export function canStop(item: WorkItem): boolean {
    return item.id !== UpdateWorkId;
}

export async function stopWork(item: WorkItem): Promise<void> {
    if (item.kind === "ci") {
        await ciCancel(item.dir, item.id);
        return;
    }
    await missionCancel(item.dir, item.id);
}

export function useRunningWork(): WorkItem[] {
    const [items, setItems] = useState<WorkItem[]>([]);
    const [tick, setTick] = useState(0);
    const updating = useAtomValue(GoldUpdateModel.getInstance().busyAtom, { store: globalStore });
    useEffect(() => {
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const next = await TabRpcClient.wshRpcCall(WorkCommand, {}, { route: MissionRouteId, timeout: 15000 });
                if (!cancelled) {
                    setItems((next as WorkItem[]) ?? []);
                }
            } catch {
                // The panel keeps what it last read.
            }
        });
        return () => {
            cancelled = true;
        };
    }, [tick]);
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> = null;
        const soon = () => {
            if (timer != null) {
                return;
            }
            timer = setTimeout(() => {
                timer = null;
                setTick((t) => t + 1);
            }, WorkRefreshDelayMs);
        };
        const unsubscribes = [MissionRunEvent, MissionCiEvent].map((eventType) =>
            waveEventSubscribeSingle({ eventType: eventType as WaveEventName, handler: soon })
        );
        return () => {
            unsubscribes.forEach((fn) => fn());
            if (timer != null) {
                clearTimeout(timer);
            }
        };
    }, []);
    const busy = items.length > 0;
    useEffect(() => {
        const timer = setInterval(() => setTick((t) => t + 1), busy ? WorkPollMs : IdlePollMs);
        return () => clearInterval(timer);
    }, [busy]);
    if (!updating) {
        return items;
    }
    return [
        { id: UpdateWorkId, kind: "update", dir: "", title: "Updating MoltenTerm", startedat: 0, progress: -1 },
        ...items,
    ];
}
