// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first fit of a terminal used to send its size to the block controller before the resync that creates the
// controller, so every tab view loaded with "no controller found for block" (FR-PERF-005). The first sync resyncs
// (a new controller starts at the size of that moment); every size is sent once that resync is done, in order: a
// controller that was already running needs it, since a resync leaves it untouched, and a resize landing while the
// resync is in flight must not be lost.

export class ControllerSizeSync {
    resynced: Promise<void> = null;
    resync: () => Promise<void>;
    sendSize: (termSize: TermSize) => Promise<void>;
    onError: (err: unknown) => void;

    constructor(
        resync: () => Promise<void>,
        sendSize: (termSize: TermSize) => Promise<void>,
        onError: (err: unknown) => void
    ) {
        this.resync = resync;
        this.sendSize = sendSize;
        this.onError = onError;
    }

    // termSize is null when the fit did not change the size
    sync(termSize: TermSize): Promise<void> {
        if (this.resynced == null) {
            this.resynced = this.resync().catch((e) => this.onError(e));
        }
        if (termSize == null) {
            return this.resynced;
        }
        return this.resynced.then(() => this.sendSize(termSize)).catch((e) => this.onError(e));
    }
}
