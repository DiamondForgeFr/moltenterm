// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { LogsEdge } from "../frontend/moltenterm-shell/logs/logs-model";
import { LogsHighWatch, LogsListener, LogsRelay, makeLogsService } from "./moltenterm-logs-service";

const Mark = 1000;

function listener(id: number, alive = true) {
    const state = { alive, got: [] as LogsEdge[], throws: false };
    const l: LogsListener = {
        id,
        alive: () => state.alive,
        send: (edge) => {
            if (state.throws) {
                throw new Error("window gone");
            }
            state.got.push(edge);
        },
    };
    return { l, state };
}

describe("the high mark of the logs (#2335)", () => {
    it("says what the first reading is, whichever side of the mark it is on", () => {
        expect(new LogsHighWatch(Mark).note(10)).toEqual({ high: false, total: 10, highMark: Mark });
        expect(new LogsHighWatch(Mark).note(Mark)).toEqual({ high: true, total: Mark, highMark: Mark });
    });

    it("says it once per crossing, never on repeat", () => {
        const watch = new LogsHighWatch(Mark);
        watch.note(10);
        expect(watch.note(20)).toBeNull();
        expect(watch.note(1500)?.high).toBe(true);
        expect(watch.note(1800)).toBeNull();
        expect(watch.note(Mark + 1)).toBeNull();
        expect(watch.note(5)?.high).toBe(false);
        expect(watch.note(1200)?.high).toBe(true);
    });
});

describe("telling one window (#2335)", () => {
    it("keeps an edge no window can take until the first one listens", () => {
        const relay = new LogsRelay(Mark);
        relay.note(2000);
        const a = listener(1);
        expect(relay.listen(a.l)).toEqual({ high: true, total: 2000, highMark: Mark });
        // Taken once: another window that listens gets nothing.
        const b = listener(2);
        expect(relay.listen(b.l)).toBeNull();
        expect(a.state.got).toEqual([]);
    });

    it("sends the next edge to one window only, the oldest still there", () => {
        const relay = new LogsRelay(Mark);
        const a = listener(1);
        const b = listener(2);
        relay.listen(a.l);
        relay.listen(b.l);
        relay.note(2000);
        expect(a.state.got.length).toBe(1);
        expect(b.state.got.length).toBe(0);
        a.state.alive = false;
        relay.note(5);
        expect(b.state.got.map((e) => e.high)).toEqual([false]);
    });

    it("counts a window that listens twice once", () => {
        const relay = new LogsRelay(Mark);
        const a = listener(1);
        relay.listen(a.l);
        relay.listen(a.l);
        relay.note(2000);
        expect(a.state.got.length).toBe(1);
    });

    it("goes on to the next window when one cannot take it", () => {
        const relay = new LogsRelay(Mark);
        const a = listener(1);
        const b = listener(2);
        relay.listen(a.l);
        relay.listen(b.l);
        a.state.throws = true;
        relay.note(2000);
        expect(a.state.got).toEqual([]);
        expect(b.state.got.length).toBe(1);
    });

    it("keeps the edge when every window is gone, and lets the newest edge replace it", () => {
        const relay = new LogsRelay(Mark);
        const a = listener(1);
        relay.listen(a.l);
        a.state.alive = false;
        relay.note(2000);
        relay.note(10);
        expect(relay.listen(listener(2).l)?.high).toBe(false);
    });
});

describe("the logs service (#2335)", () => {
    function service(
        sizes: { total: number },
        lines: string[],
        clearResult = { ok: true, removed: 3, freed: 900, failed: 0 }
    ) {
        return makeLogsService({
            files: {
                clear: async () => {
                    const before = sizes.total;
                    sizes.total = 12;
                    return { ...clearResult, freed: clearResult.freed || before };
                },
            },
            read: async () => ({ total: sizes.total, current: sizes.total, rotated: 0, files: 1 }),
            log: (line) => lines.push(line),
            highMark: Mark,
        });
    }

    it("answers the sizes with the high mark, and no path", async () => {
        const sizes = { total: 321 };
        const info = await service(sizes, []).info();
        expect(info).toEqual({ total: 321, current: 321, rotated: 0, files: 1, highMark: Mark });
        expect(JSON.stringify(info)).not.toContain("/");
    });

    it("clears, answers the sizes after and writes one line about it", async () => {
        const sizes = { total: 5000 };
        const lines: string[] = [];
        const answer = await service(sizes, lines).clear();
        expect(answer.ok).toBe(true);
        expect(answer.removed).toBe(3);
        expect(answer.info.total).toBe(12);
        expect(lines).toEqual(["logs cleared from Settings: 3 rotated files removed, 900 bytes freed"]);
    });

    it("says what could not be removed", async () => {
        const lines: string[] = [];
        const answer = await service({ total: 40 }, lines, { ok: false, removed: 1, freed: 10, failed: 2 }).clear();
        expect(answer.ok).toBe(false);
        expect(lines[0]).toContain("2 not removed");
    });

    it("tells the listening window when a clear brings the logs back under the mark", async () => {
        const sizes = { total: 5000 };
        const svc = service(sizes, []);
        const a = listener(1);
        svc.listen(a.l);
        svc.note({ total: 5000, current: 5000, rotated: 0, files: 1 });
        await svc.clear();
        expect(a.state.got.map((e) => e.high)).toEqual([true, false]);
    });
});
