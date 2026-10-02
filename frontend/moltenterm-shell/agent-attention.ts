// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Records an agent's signal as a notification of the terminal's workspace (FR-SHELL-003). A signal from the block
// the user is looking at is recorded as read: the user already sees it.

import { getFocusedBlockId } from "@/app/store/global";
import { AttentionSignal, BellSignal, parseOsc777, parseOsc9, shouldRecord } from "./agent-attention-model";
import { addMoltentermNotification } from "./notifications-store";

const lastSignalByBlock = new Map<string, number>();

function record(blockId: string, signal: AttentionSignal): void {
    if (signal == null || blockId == null || !shouldRecord(lastSignalByBlock, blockId, Date.now())) {
        return;
    }
    const seen = document.hasFocus() && document.visibilityState === "visible" && getFocusedBlockId() === blockId;
    addMoltentermNotification({
        source: "agent",
        title: signal.title,
        message: signal.message,
        kind: "warning",
        blockid: blockId,
        read: seen,
    });
}

// The OSC handlers return true: the sequence is consumed, as a terminal that shows notifications does.
export function handleAttentionOsc9(data: string, blockId: string, loaded: boolean): boolean {
    if (loaded) {
        record(blockId, parseOsc9(data));
    }
    return true;
}

export function handleAttentionOsc777(data: string, blockId: string, loaded: boolean): boolean {
    if (loaded) {
        record(blockId, parseOsc777(data));
    }
    return true;
}

export function handleAttentionBell(blockId: string): void {
    record(blockId, BellSignal);
}
