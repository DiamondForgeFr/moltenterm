// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the agents' browser module (moltenterm-browseragent.ts, FR-BRW-010) tells the downloads module
// (moltenterm-downloads.ts, #1992) about a download, kept apart so the two do not import each other: both listen to
// the session's will-download, the downloads module first, so it cannot see yet whether the agent module held the
// download back.
//
// #1985 (downloads from tabs an agent opened) will hold more downloads back through markHeld, and #1982 (reputation
// and the executable warning at download time) will do the same: a held download is never listed, since nothing was
// received.

const heldItems = new WeakSet<object>();

// The agent module cancelled this download and asks the user first.
export function markHeld(item: object): void {
    heldItems.add(item);
}

export function isHeld(item: object): boolean {
    return heldItems.has(item);
}

type AgentDownload = { agent: string; until: number };

// A download the user allowed is started again by emain: the agent that started it, for the row.
const AgentDownloadWindowMs = 60000;
const agentDownloads = new Map<string, AgentDownload>();

function agentKey(sourceId: number, url: string): string {
    return `${sourceId}|${url}`;
}

export function noteAgentDownload(sourceId: number, url: string, agent: string, now: number = Date.now()): void {
    if (!agent) {
        return;
    }
    agentDownloads.set(agentKey(sourceId, url), { agent, until: now + AgentDownloadWindowMs });
}

// Read once, by the downloads module, when the restarted download arrives.
export function takeAgentDownload(sourceId: number, url: string, now: number = Date.now()): string {
    const key = agentKey(sourceId, url);
    const found = agentDownloads.get(key);
    agentDownloads.delete(key);
    return found != null && now < found.until ? found.agent : "";
}
