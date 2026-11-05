// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The hand-off requests that wait for the developer, as the foreman's card shows them (FR-BOSS-005, #1891). wavesrv
// holds the list (#1926) and tells the windows when it changed; this keeps the window's copy and gives the developer's
// answer to the same route the request's notification answers through, so a row and a notification are two views of
// one request: answering either removes both. It asks for nothing while no bubble is on screen.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import {
    AgentHandoffDecision,
    AgentHandoffPendingEvent,
    answerAgentHandoff,
    PendingHandoff,
    readPendingHandoffs,
} from "../agent-handoff";

// The window may start before wavesrv answers: the read is tried again a few times, then left to the next event.
const ReadRetryMs = 2000;
const ReadMaxTries = 10;

export class PendingHandoffs {
    private static instance: PendingHandoffs = null;

    dataAtom = atom([]) as PrimitiveAtom<PendingHandoff[]>;
    // True once a reading is in: a window starting is not a request arriving.
    loadedAtom = atom(false) as PrimitiveAtom<boolean>;

    private users = 0;
    private unsubscribe: () => void = null;
    private inFlight = false;
    private again = false;
    private retryTimer: ReturnType<typeof setTimeout> = null;

    private constructor() {}

    static getInstance(): PendingHandoffs {
        if (PendingHandoffs.instance == null) {
            PendingHandoffs.instance = new PendingHandoffs();
        }
        return PendingHandoffs.instance;
    }

    static resetInstance(): void {
        PendingHandoffs.instance = null;
    }

    // One subscription for every user of the list in this window.
    start(): () => void {
        this.users++;
        if (this.users === 1) {
            this.open();
        }
        let stopped = false;
        return () => {
            if (stopped) {
                return;
            }
            stopped = true;
            this.users--;
            if (this.users === 0) {
                this.close();
            }
        };
    }

    private open(): void {
        try {
            this.unsubscribe = waveEventSubscribeSingle({
                eventType: AgentHandoffPendingEvent as WaveEventName,
                handler: () => this.load(),
            });
        } catch (e) {
            // The preview server has no event bus.
            console.log("boss handoffs: no event bus", e);
            return;
        }
        this.load();
    }

    private close(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.stopRetry();
        this.again = false;
        globalStore.set(this.dataAtom, []);
        globalStore.set(this.loadedAtom, false);
    }

    private stopRetry(): void {
        if (this.retryTimer != null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    // Reads the list again; a read in flight is followed by one more, so the last change is always seen.
    load(): void {
        if (this.users === 0) {
            return;
        }
        this.stopRetry();
        if (this.inFlight) {
            this.again = true;
            return;
        }
        this.read(0);
    }

    private read(tries: number): void {
        this.inFlight = true;
        fireAndForget(async () => {
            let failed = false;
            try {
                const entries = await readPendingHandoffs();
                if (this.users > 0) {
                    globalStore.set(this.dataAtom, entries);
                    globalStore.set(this.loadedAtom, true);
                }
            } catch (e) {
                failed = true;
                console.log("boss handoffs: could not read the requests", e);
            } finally {
                this.inFlight = false;
                this.afterRead(failed, tries);
            }
        });
    }

    private afterRead(failed: boolean, tries: number): void {
        if (this.users === 0) {
            return;
        }
        if (this.again) {
            this.again = false;
            this.read(0);
            return;
        }
        if (failed && tries + 1 < ReadMaxTries) {
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                this.read(tries + 1);
            }, ReadRetryMs);
        }
    }

    // The developer's answer, through the route the notification's buttons use. An answer that wavesrv did not take
    // throws its words; the list is read again either way, so a request that is gone leaves the card.
    async answer(requestid: string, decision: AgentHandoffDecision): Promise<void> {
        const result = await answerAgentHandoff({ requestid, decision });
        if (result.ok) {
            globalStore.set(this.dataAtom, (list) => list.filter((entry) => entry.requestid !== requestid));
        }
        this.load();
        if (!result.ok) {
            throw new Error(result.error);
        }
    }
}
