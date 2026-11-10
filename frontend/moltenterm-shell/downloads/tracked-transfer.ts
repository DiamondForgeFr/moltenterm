// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Every download MoltenTerm makes for the developer shows in Brokk's Downloads (FR-BOSS-009 AC61, #2163). The web
// pages' downloads keep their own record and row (downloads-model.ts); any other source (the in-app update, and later
// the Files panel, a command) gives the section one tracked transfer, drawn from its owner's state and never stored
// twice. The section, the ring on Brokk's face and the rail read the transfers through the registry in
// downloads-store.ts, so a new source plugs in without touching them. Words stay keys here, translated where shown.

export type TransferPhase = "running" | "verifying" | "done" | "failed";

// A key of the interface and its values, never words: the language can change while the transfer runs.
export type TransferText = { key: string; vars?: Record<string, string | number> };

export type TransferAction = {
    id: string;
    label: TransferText;
    // The phase's main action, drawn as such.
    main?: boolean;
    // The action takes the developer somewhere else: the surface that hosts the section closes.
    leaves?: boolean;
};

export type TrackedTransfer = {
    // Unique across the sources: "<source>:<id of the owner>".
    id: string;
    title: TransferText;
    // Where it comes from, one short line.
    origin: TransferText;
    icon: string;
    phase: TransferPhase;
    // Bytes, or any unit both share (a percentage is received/100); total 0 is an unknown size.
    received: number;
    total: number;
    // What the phase says beyond the bar: "Verifying", "Ready to restart", the reason of a failure.
    status?: TransferText;
    failed?: boolean;
    actions: TransferAction[];
};

// The owner of some transfers: what it has now (an atom the section reads) and what its actions do.
export type TransferSource<A = unknown> = {
    id: string;
    transfersAtom: A;
    act: (transferId: string, actionId: string) => Promise<void> | void;
};

export function isRunningTransfer(transfer: Pick<TrackedTransfer, "phase">): boolean {
    return transfer.phase === "running" || transfer.phase === "verifying";
}

// What the rings and the rail count of a running transfer: the shape of a running download's progress. A verifying
// transfer has no measured part left, so it counts as running without a size.
export type RingEntry = { state: "progressing"; received: number; total: number };

export function ringEntryOf(transfer: TrackedTransfer): RingEntry {
    if (transfer.phase === "verifying") {
        return { state: "progressing", received: 0, total: 0 };
    }
    return { state: "progressing", received: transfer.received, total: transfer.total };
}

export function runningRingEntries(transfers: TrackedTransfer[]): RingEntry[] {
    return transfers.filter(isRunningTransfer).map(ringEntryOf);
}

export function transferPercent(transfer: Pick<TrackedTransfer, "received" | "total">): number {
    if (!(transfer.total > 0)) {
        return null;
    }
    return Math.max(0, Math.min(100, Math.floor((transfer.received / transfer.total) * 100)));
}
