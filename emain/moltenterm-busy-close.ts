// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Electron main asks a renderer what a window close, a quit, a workspace delete or a switch away from an unsaved
// workspace would stop (FR-SHELL-062, DS-SHELL-109). The renderer acks at once, reads what runs (FR-SHELL-061's reader,
// through wavesrv, so it sees every workspace) and, when something runs, shows MoltenTerm's dialog in place of
// Electron's own confirmation. No ack within BusyAskAckTimeoutMs, a renderer that goes away, the setting off or
// nothing running: Electron's confirmation decides as before (fallsBackToElectron).

import {
    BusyAskAckTimeoutMs,
    BusyAskReply,
    BusyAskRequest,
    BusyOutcomeCancel,
    BusyOutcomeClose,
    BusyOutcomeNoAnswer,
    BusyOutcomeNone,
    BusyOutcomeOff,
    BusyPhaseAck,
    BusyPhaseAsking,
    BusyPhaseResult,
    BusyStops,
} from "./moltenterm-busy-close-policy";

export const BusyAskChannel = "moltenterm-busy-ask";
export const BusyReplyChannel = "moltenterm-busy-reply";

export type BusyAskTarget = {
    id: number;
    isDestroyed(): boolean;
    send(channel: string, ...args: any[]): void;
    once?(event: string, listener: (...args: any[]) => void): any;
    removeListener?(event: string, listener: (...args: any[]) => void): any;
};

type Pending = {
    senderId: number;
    acked: boolean;
    finish: (outcome: string) => void;
    onAsking?: () => void;
};

const KnownOutcomes = new Set([BusyOutcomeOff, BusyOutcomeNone, BusyOutcomeClose, BusyOutcomeCancel]);

export type BusyAsker = {
    ask(
        target: BusyAskTarget,
        kind: string,
        stops: BusyStops,
        opts?: { name?: string; onAsking?: () => void }
    ): Promise<string>;
    handleReply(senderId: number, reply: BusyAskReply): void;
    pendingCount(): number;
};

export function makeBusyAsker(ackTimeoutMs = BusyAskAckTimeoutMs): BusyAsker {
    const pending = new Map<string, Pending>();
    let seq = 0;

    function ask(
        target: BusyAskTarget,
        kind: string,
        stops: BusyStops,
        opts?: { name?: string; onAsking?: () => void }
    ): Promise<string> {
        if (typeof target?.send !== "function" || typeof target.isDestroyed !== "function" || target.isDestroyed()) {
            return Promise.resolve(BusyOutcomeNoAnswer);
        }
        seq++;
        const requestid = `busy-${Date.now()}-${seq}`;
        return new Promise<string>((resolve) => {
            let done = false;
            const gone = () => finish(BusyOutcomeNoAnswer);
            const finish = (outcome: string) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                pending.delete(requestid);
                target.removeListener?.("destroyed", gone);
                target.removeListener?.("render-process-gone", gone);
                resolve(outcome);
            };
            const timer = setTimeout(() => {
                if (!pending.get(requestid)?.acked) {
                    console.log("[#490] no answer from the renderer, Electron's confirmation decides", kind);
                    finish(BusyOutcomeNoAnswer);
                }
            }, ackTimeoutMs);
            pending.set(requestid, { senderId: target.id, acked: false, finish, onAsking: opts?.onAsking });
            // A renderer that crashes or is closed while its dialog is open never answers.
            target.once?.("destroyed", gone);
            target.once?.("render-process-gone", gone);
            const request: BusyAskRequest = {
                requestid,
                kind,
                stopworkspaceids: stops?.stopworkspaceids ?? [],
                quit: !!stops?.quit,
                name: opts?.name,
            };
            try {
                target.send(BusyAskChannel, request);
            } catch (e) {
                console.log("[#490] could not ask the renderer", e);
                finish(BusyOutcomeNoAnswer);
            }
        });
    }

    function handleReply(senderId: number, reply: BusyAskReply) {
        const entry = pending.get(reply?.requestid);
        if (entry == null || entry.senderId !== senderId) {
            return;
        }
        if (reply.phase === BusyPhaseAck) {
            entry.acked = true;
            return;
        }
        if (reply.phase === BusyPhaseAsking) {
            entry.acked = true;
            try {
                entry.onAsking?.();
            } catch (e) {
                console.log("[#490] showing the window that asks", e);
            }
            return;
        }
        if (reply.phase === BusyPhaseResult) {
            entry.finish(KnownOutcomes.has(reply.outcome) ? reply.outcome : BusyOutcomeNoAnswer);
        }
    }

    return { ask, handleReply, pendingCount: () => pending.size };
}

let sharedAsker: BusyAsker = null;

function asker(): BusyAsker {
    if (sharedAsker == null) {
        sharedAsker = makeBusyAsker();
    }
    return sharedAsker;
}

let listening = false;

export function initBusyCloseReplies(ipcMain: {
    on(channel: string, listener: (event: any, reply: any) => void): any;
}) {
    if (listening) {
        return;
    }
    listening = true;
    ipcMain.on(BusyReplyChannel, (event, reply: BusyAskReply) => asker().handleReply(event?.sender?.id, reply));
}

export function askBusyStop(
    target: BusyAskTarget,
    kind: string,
    stops: BusyStops,
    opts?: { name?: string; onAsking?: () => void }
): Promise<string> {
    return asker().ask(target, kind, stops, opts);
}

// One dialog per action: a second close of the same window, or a second quit, while the first one asks is dropped
// (answered as a cancel, so the action that already asks decides alone).
export function makeAskOnce() {
    const busy = new Set<string>();
    return async function askOnce(key: string, work: () => Promise<string>): Promise<string> {
        if (busy.has(key)) {
            return BusyOutcomeCancel;
        }
        busy.add(key);
        try {
            return await work();
        } finally {
            busy.delete(key);
        }
    };
}

export const askOncePerAction = makeAskOnce();
