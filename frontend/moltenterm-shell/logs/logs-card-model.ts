// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the Logs block of Settings › Advanced shows and when (FR-PERF-016, DS-PERF-015, #2335): the size read when the
// section opens, the inline confirmation Clear logs asks, and how the clear ended. Nothing changes by itself: every
// change of the files is the developer's click.

import type { LogsClearAnswer, LogsSummary } from "./logs-model";

export type LogsOutcome = "" | "cleared" | "partial" | "failed";

export type LogsCardState = {
    // Null until read, and when Electron main cannot say.
    info: LogsSummary;
    loaded: boolean;
    confirming: boolean;
    busy: boolean;
    outcome: LogsOutcome;
    freed: number;
};

export type LogsCardAction =
    | { type: "read"; info: LogsSummary }
    | { type: "ask" }
    | { type: "cancel" }
    | { type: "start" }
    | { type: "done"; answer: LogsClearAnswer };

export function initialLogsCardState(): LogsCardState {
    return { info: null, loaded: false, confirming: false, busy: false, outcome: "", freed: 0 };
}

export function logsCardReducer(state: LogsCardState, action: LogsCardAction): LogsCardState {
    switch (action.type) {
        case "read":
            return { ...state, info: action.info, loaded: true };
        case "ask":
            return state.busy || state.info == null ? state : { ...state, confirming: true, outcome: "" };
        case "cancel":
            return { ...state, confirming: false };
        case "start":
            return state.busy ? state : { ...state, busy: true };
        case "done": {
            const { answer } = action;
            if (answer == null) {
                return { ...state, busy: false, confirming: false, outcome: "failed", freed: 0 };
            }
            return {
                ...state,
                info: answer.info ?? state.info,
                busy: false,
                confirming: false,
                outcome: answer.ok ? "cleared" : "partial",
                freed: answer.freed,
            };
        }
    }
}
