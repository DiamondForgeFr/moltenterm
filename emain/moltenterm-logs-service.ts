// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What Electron main answers about the logs (FR-PERF-016, #2335), apart from Electron so it can be tested: the sizes,
// the clear, and the one window told when the logs cross the high mark. The files are moltenterm-log-files.ts's.

import type { LogsClearAnswer, LogsEdge, LogsSummary } from "../frontend/moltenterm-shell/logs/logs-model";
import { ClearResult, LogsHighMarkBytes, LogsInfo } from "./moltenterm-log-files";

// Which side of the high mark the logs are on. The first reading always says: a note kept from an earlier launch may
// have to settle, and one that was never said may have to be.
export class LogsHighWatch {
    private high: boolean = null;

    constructor(private readonly mark: number) {}

    note(total: number): LogsEdge {
        const high = total >= this.mark;
        if (high === this.high) {
            return null;
        }
        this.high = high;
        return { high, total, highMark: this.mark };
    }
}

export type LogsListener = { id: number; alive: () => boolean; send: (edge: LogsEdge) => void };

// Tells one window and only one: the oldest that listens and is still there. An edge no window can take yet (the
// windows are still loading) waits for the first one that listens.
export class LogsRelay {
    private readonly watch: LogsHighWatch;
    private pending: LogsEdge = null;
    private listeners: LogsListener[] = [];

    constructor(mark: number) {
        this.watch = new LogsHighWatch(mark);
    }

    note(total: number): void {
        const edge = this.watch.note(total);
        if (edge != null) {
            this.deliver(edge);
        }
    }

    listen(listener: LogsListener): LogsEdge {
        if (!this.listeners.some((l) => l.id === listener.id)) {
            this.listeners.push(listener);
        }
        this.listeners = this.listeners.filter((l) => l.alive());
        const edge = this.pending;
        this.pending = null;
        return edge;
    }

    private deliver(edge: LogsEdge): void {
        this.listeners = this.listeners.filter((l) => l.alive());
        for (const listener of this.listeners) {
            try {
                listener.send(edge);
                this.pending = null;
                return;
            } catch {
                // This window is going away: the next one gets it.
            }
        }
        this.pending = edge;
    }
}

export type LogsServiceDeps = {
    files: { clear: () => Promise<ClearResult> };
    read: () => Promise<LogsInfo>;
    log: (line: string) => void;
    highMark?: number;
};

export function makeLogsService(deps: LogsServiceDeps) {
    const mark = deps.highMark ?? LogsHighMarkBytes;
    const relay = new LogsRelay(mark);
    const summary = async (): Promise<LogsSummary> => ({ ...(await deps.read()), highMark: mark });
    return {
        info: summary,
        // After every maintenance of the files: what they now weigh.
        note: (info: LogsInfo): void => relay.note(info.total),
        listen: (listener: LogsListener): LogsEdge => relay.listen(listener),
        clear: async (): Promise<LogsClearAnswer> => {
            const result = await deps.files.clear();
            const info = await summary();
            relay.note(info.total);
            deps.log(
                `logs cleared from Settings: ${result.removed} rotated files removed, ${result.freed} bytes freed` +
                    (result.failed > 0 ? `, ${result.failed} not removed` : "")
            );
            return { ok: result.ok, removed: result.removed, freed: result.freed, failed: result.failed, info };
        },
    };
}
