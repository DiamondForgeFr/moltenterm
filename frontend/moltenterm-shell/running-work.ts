// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What runs now, for the notification center (FR-MC-019) and the activity source (FR-BOSS-009, AC85): the builds, release
// and adapter steps and local CI runs of every project (pkg/molten/mission/work.go), and the gold update while it is
// applied. One reading serves them all: the run and CI events of every project keep it current, and a panel that wants
// it fresher adds its own poll while it shows.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { t } from "./i18n/i18n";
import type { ServerText } from "./i18n/server-text";
import { ciCancel, missionCancel, MissionCiEvent, MissionRouteId, MissionRunEvent } from "./mission/mission-client";
import { TabActivity, whileShown } from "./tab-activity";
import { GoldUpdateModel } from "./update/update-store";
import { onEventsResubscribed } from "./ws-resubscribe";

// must match WorkItem in pkg/molten/mission/work.go
export type WorkItem = {
    id: string;
    kind: string;
    dir: string;
    // The workspace linked to the project, absent when none is.
    workspaceid?: string;
    title: string;
    detail?: string;
    detailtext?: ServerText;
    startedat: number;
    // From 0 to 1, or -1 when the work does not say.
    progress: number;
};

export const WorkCommand = "moltenmissionwork";
export const UpdateWorkId = "gold-update";

const WorkRefreshDelayMs = 300;
const WorkPollMs = 3000;
const IdlePollMs = 30000;
const WorkRpcTimeoutMs = 15000;

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

// The running work as wavesrv last said it. It is read when the first watcher comes and again, after a short pause that
// gathers a burst, on each run or CI event and after a websocket reconnect (an event published while the link was down
// never came). It starts no timer of its own.
export class RunningWork {
    private static instance: RunningWork = null;

    itemsAtom = atom([]) as PrimitiveAtom<WorkItem[]>;
    watchers = 0;
    stopWatching: () => void = null;
    pause: ReturnType<typeof setTimeout> = null;
    asked = 0;
    answered = 0;

    private constructor() {}

    static getInstance(): RunningWork {
        if (RunningWork.instance == null) {
            RunningWork.instance = new RunningWork();
        }
        return RunningWork.instance;
    }

    static resetInstance(): void {
        RunningWork.instance?.stopWatching?.();
        RunningWork.instance = null;
    }

    // The answer of the latest ask wins: a slow answer to an older one is dropped.
    async refresh(): Promise<void> {
        const ask = ++this.asked;
        try {
            const next = ((await TabRpcClient.wshRpcCall(
                WorkCommand,
                {},
                {
                    route: MissionRouteId,
                    timeout: WorkRpcTimeoutMs,
                }
            )) ?? []) as WorkItem[];
            if (ask < this.answered) {
                return;
            }
            this.answered = ask;
            const current = globalStore.get(this.itemsAtom);
            if (JSON.stringify(current) !== JSON.stringify(next)) {
                globalStore.set(this.itemsAtom, next);
            }
        } catch {
            // The reading keeps what it last had.
        }
    }

    refreshSoon(): void {
        if (this.pause != null) {
            return;
        }
        this.pause = setTimeout(() => {
            this.pause = null;
            fireAndForget(() => this.refresh());
        }, WorkRefreshDelayMs);
    }

    private startWatching(): () => void {
        const unsubscribes = [MissionRunEvent, MissionCiEvent].map((eventType) =>
            waveEventSubscribeSingle({ eventType: eventType as WaveEventName, handler: () => this.refreshSoon() })
        );
        unsubscribes.push(onEventsResubscribed(() => this.refreshSoon()));
        fireAndForget(() => this.refresh());
        return () => {
            unsubscribes.forEach((fn) => fn());
            if (this.pause != null) {
                clearTimeout(this.pause);
                this.pause = null;
            }
        };
    }

    // Keeps the reading current while the caller shows something that needs it; the returned function lets go.
    watch(): () => void {
        this.watchers++;
        if (this.watchers === 1) {
            this.stopWatching = this.startWatching();
        }
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.watchers--;
            if (this.watchers === 0) {
                this.stopWatching?.();
                this.stopWatching = null;
            }
        };
    }
}

export function useRunningWork(): WorkItem[] {
    const source = RunningWork.getInstance();
    const items = useAtomValue(source.itemsAtom, { store: globalStore });
    const updating = useAtomValue(GoldUpdateModel.getInstance().busyAtom, { store: globalStore });
    useEffect(() => source.watch(), [source]);
    const busy = items.length > 0;
    // The run and CI events keep the reading current while the panel is hidden too; the poll only catches what they miss.
    useEffect(
        () =>
            TabActivity.getInstance().every(
                whileShown(busy ? WorkPollMs : IdlePollMs),
                () => fireAndForget(() => source.refresh()),
                "bell-work"
            ),
        [busy, source]
    );
    if (!updating) {
        return items;
    }
    return [
        { id: UpdateWorkId, kind: "update", dir: "", title: t("agent.updating"), startedat: 0, progress: -1 },
        ...items,
    ];
}
