// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pace of a terminal's cache save (#849). Wave serializes the whole buffer on the page's thread every 5 s while
// output flows: a busy agent terminal with a long scrollback on a loaded machine can make that a long task, repeated
// for each terminal. The pause after a save grows with what the save cost, so the saves never take more than about
// 5 % of the thread.

export const TermCacheBaseDelayMs = 5000;
export const TermCacheMaxDelayMs = 60000;
export const TermCacheDutyFactor = 20;
// A save this slow is logged: it is a likely cause when the window feels stuck.
export const TermCacheSlowLogMs = 500;

export function nextTermCacheDelayMs(tookMs: number): number {
    const paced = Math.round((tookMs > 0 ? tookMs : 0) * TermCacheDutyFactor);
    return Math.min(TermCacheMaxDelayMs, Math.max(TermCacheBaseDelayMs, paced));
}
