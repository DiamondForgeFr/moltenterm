// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { endedMessage, notReadyMessage, ReadyAnswer, sendWhenReady } from "./review-ready";

type Answer = ReadyAnswer & { sent: boolean };

// A fake wavesrv: the agent answers starting until ready() says otherwise; a fake clock advanced by sleep.
function fake(readyAfter: number) {
    let clock = 0;
    const calls: number[] = [];
    const waits: string[] = [];
    const send = async (): Promise<Answer> => {
        calls.push(clock);
        if (clock < readyAfter) {
            return { sent: false, starting: true, message: "Claude Code is starting: this is sent once it is ready." };
        }
        return { sent: true };
    };
    return {
        send,
        calls,
        waits,
        now: () => clock,
        sleep: async (ms: number) => {
            clock += ms;
        },
        onWaiting: (m: string) => waits.push(m),
    };
}

describe("sendWhenReady (#638)", () => {
    it("holds the text until the session's agent is ready, then sends it once", async () => {
        const f = fake(3_000);
        const out = await sendWhenReady(f.send, {
            what: "question",
            alive: () => true,
            now: f.now,
            sleep: f.sleep,
            onWaiting: f.onWaiting,
        });
        expect(out.dropped).toBeUndefined();
        expect(out.result).toEqual({ sent: true });
        expect(f.calls).toEqual([0, 1_000, 2_000, 3_000]);
        expect(f.waits).toHaveLength(3);
        expect(f.waits[0]).toContain("is starting");
    });

    it("sends right away to a ready agent", async () => {
        const f = fake(0);
        const out = await sendWhenReady(f.send, { what: "comment", alive: () => true, now: f.now, sleep: f.sleep });
        expect(out.result?.sent).toBe(true);
        expect(f.calls).toEqual([0]);
    });

    it("drops the text with a message when the session ends before its agent is ready", async () => {
        const f = fake(10_000);
        let alive = true;
        const out = await sendWhenReady(f.send, {
            what: "comment",
            alive: () => alive,
            now: f.now,
            sleep: async (ms) => {
                await f.sleep(ms);
                if (f.now() >= 2_000) {
                    alive = false;
                }
            },
        });
        expect(out.result).toBeUndefined();
        expect(out.dropped).toBe(endedMessage("comment"));
        expect(out.dropped).toContain("your comment was not sent");
        expect(f.calls).toEqual([0, 1_000]);
    });

    it("gives up after the deadline when the agent never gets ready", async () => {
        const f = fake(Number.MAX_SAFE_INTEGER);
        const out = await sendWhenReady(f.send, {
            what: "translation",
            alive: () => true,
            now: f.now,
            sleep: f.sleep,
            deadlineMs: 5_000,
        });
        expect(out.dropped).toBe(notReadyMessage("translation"));
        expect(f.calls.length).toBe(6);
    });

    it("keeps an answer other than starting as the outcome (busy, typed without Enter)", async () => {
        const out = await sendWhenReady(async () => ({ sent: false, busy: true, message: "working" }), {
            what: "question",
            alive: () => true,
        });
        expect(out.result).toEqual({ sent: false, busy: true, message: "working" });
    });
});
