// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the windows and wavesrv's handoff route exchange (pkg/molten/handoffwire), without the calls: the models that
// only read a request import this and load nothing of the RPC client.

// A request's notification is keyed by its id (must match handoffwire.NotificationKeyPrefix): the card's row for the
// request stands for it.
export const AgentHandoffNotificationKeyPrefix = "agenthandoff:";

export type AgentHandoffDecision = "once" | "always" | "block" | "dismiss";

// What the sender attached, as wavesrv lists it: paths and the sender's words, never a file's content.
export type PendingHandoffFile = { path: string; project?: string; lines?: string; note?: string; excerpt?: string };
export type PendingHandoffLink = { url?: string; title?: string; kind?: string; note?: string };
export type PendingHandoffBrief = {
    goal: string;
    context?: string;
    files?: PendingHandoffFile[];
    links?: PendingHandoffLink[];
    reply?: boolean;
};

export type PendingHandoff = {
    requestid: string;
    fromblockid: string;
    toblockid: string;
    // "" for a terminal that has no name: the window words it.
    from: string;
    to: string;
    goal?: string;
    createdat?: number;
    fromworkspace?: string;
    toworkspace?: string;
    fromproject?: string;
    toproject?: string;
    brief?: PendingHandoffBrief;
};
