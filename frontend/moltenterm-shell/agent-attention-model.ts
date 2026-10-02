// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Coding agents ask for attention through the terminal (FR-SHELL-003, DS-SHELL-004): the bell, OSC 9 (iTerm2's
// notification, used by Codex and by Claude Code set to iterm2) and OSC 777 (`notify;title;body`, used by several
// tools). This module turns those payloads into notifications; termwrap.ts forwards them.

export type AttentionSignal = { title: string; message?: string };

// OSC 9 also carries ConEmu's progress reports ("4;state;percent"), which are not notifications.
export function parseOsc9(data: string): AttentionSignal {
    const text = (data ?? "").trim();
    if (text === "" || /^4;/.test(text)) {
        return null;
    }
    return { title: text };
}

export function parseOsc777(data: string): AttentionSignal {
    const parts = (data ?? "").split(";");
    if (parts[0] !== "notify" || parts.length < 2) {
        return null;
    }
    const title = parts[1].trim();
    const message = parts.slice(2).join(";").trim();
    if (title === "" && message === "") {
        return null;
    }
    return title === "" ? { title: message } : { title, message: message || undefined };
}

export const BellSignal: AttentionSignal = { title: "A terminal needs your attention", message: "Bell" };

// An agent rings or notifies several times for one event; one entry per block within this window.
export const AttentionDedupMs = 5000;

export function shouldRecord(lastByBlock: Map<string, number>, blockId: string, now: number): boolean {
    const last = lastByBlock.get(blockId);
    if (last != null && now - last < AttentionDedupMs) {
        return false;
    }
    lastByBlock.set(blockId, now);
    return true;
}
