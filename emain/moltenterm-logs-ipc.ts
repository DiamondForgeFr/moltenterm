// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The channels of the logs (FR-PERF-016, #2335), shared by Electron main and the preload. The answers hold sizes and
// counts, never a path: the window shows the logs and asks for them to be cleared, and main decides what that touches.
// Show in folder is the existing ShowLogChannel of the hang report (moltenterm-hang-ipc.ts).

export const LogsInfoChannel = "moltenterm-logs-info";
export const LogsClearChannel = "moltenterm-logs-clear";
// A window that can say the note of the logs asks to be told: it answers the edge waiting for a window, if there is one.
export const LogsListenChannel = "moltenterm-logs-listen";
// main -> the window that listens: the logs crossed the high mark, or are back under it
export const LogsHighChannel = "moltenterm-logs-high";
