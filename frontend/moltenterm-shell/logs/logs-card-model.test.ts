// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { initialLogsCardState, logsCardReducer } from "./logs-card-model";
import type { LogsClearAnswer, LogsSummary } from "./logs-model";

const info = (total: number): LogsSummary => ({ total, current: total, rotated: 0, files: 1, highMark: 1_000_000_000 });
const answer = (ok: boolean, total: number): LogsClearAnswer => ({
    ok,
    removed: 2,
    freed: 700,
    failed: ok ? 0 : 1,
    info: info(total),
});

describe("the Logs block of Settings (#2335)", () => {
    it("shows nothing but a reading until the size arrives, and says so when it cannot be read", () => {
        const start = initialLogsCardState();
        expect(start.loaded).toBe(false);
        const unread = logsCardReducer(start, { type: "read", info: null });
        expect(unread.loaded).toBe(true);
        expect(unread.info).toBeNull();
        expect(logsCardReducer(unread, { type: "ask" }).confirming).toBe(false);
    });

    it("asks before it clears, and Cancel changes nothing", () => {
        let state = logsCardReducer(initialLogsCardState(), { type: "read", info: info(5000) });
        state = logsCardReducer(state, { type: "ask" });
        expect(state.confirming).toBe(true);
        state = logsCardReducer(state, { type: "cancel" });
        expect(state.confirming).toBe(false);
        expect(state.info?.total).toBe(5000);
        expect(state.outcome).toBe("");
    });

    it("takes the new size once cleared, and says how much was freed", () => {
        let state = logsCardReducer(initialLogsCardState(), { type: "read", info: info(5000) });
        state = logsCardReducer(state, { type: "ask" });
        state = logsCardReducer(state, { type: "start" });
        expect(state.busy).toBe(true);
        state = logsCardReducer(state, { type: "done", answer: answer(true, 40) });
        expect(state).toMatchObject({ busy: false, confirming: false, outcome: "cleared", freed: 700 });
        expect(state.info.total).toBe(40);
    });

    it("says when only a part was removed, and when nothing could be", () => {
        const base = logsCardReducer(initialLogsCardState(), { type: "read", info: info(5000) });
        expect(logsCardReducer(base, { type: "done", answer: answer(false, 2000) }).outcome).toBe("partial");
        const failed = logsCardReducer(base, { type: "done", answer: null });
        expect(failed.outcome).toBe("failed");
        expect(failed.info.total).toBe(5000);
    });

    it("does not ask again while a clear runs", () => {
        let state = logsCardReducer(initialLogsCardState(), { type: "read", info: info(5000) });
        state = logsCardReducer(logsCardReducer(state, { type: "ask" }), { type: "start" });
        expect(logsCardReducer(state, { type: "ask" })).toBe(state);
        expect(logsCardReducer(state, { type: "start" })).toBe(state);
    });
});
