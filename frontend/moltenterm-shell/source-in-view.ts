// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the developer already has in front of them (FR-BOSS-009, AC63 and AC64, #2166): an event's source is in view
// when it is shown in this tab view while the view is the active one of the focused window (AgentSeenView, from
// makeSeenViewAtom in agent-seen.ts). Brokk does not come for it and no toast tells it. Pure, so the rule is tested
// without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { AgentSeenView } from "./agent-state-model";

export const NothingInView: AgentSeenView = { active: false, blockIds: [], focusedBlockId: null };

const BlockPrefixes = ["agent:", "finished:"];
const PrPrefixes = ["ci:", "ready:"];

// The project folder of a pull request's key ("ci:<dir>:<number>"): a folder may hold a colon itself.
function prDirOf(rest: string): string {
    const at = rest.lastIndexOf(":");
    return at <= 0 ? "" : rest.slice(0, at);
}

// The source of one of Brokk's events is in view: the pane of the agent, or the Integration panel that lists the pull
// request. An event of no surface (a download, the update, the plan usage) is never in view.
export function eventSourceInView(key: string, view: AgentSeenView): boolean {
    if (!view?.active || typeof key !== "string") {
        return false;
    }
    for (const prefix of BlockPrefixes) {
        if (key.startsWith(prefix)) {
            return (view.blockIds ?? []).includes(key.slice(prefix.length));
        }
    }
    for (const prefix of PrPrefixes) {
        if (key.startsWith(prefix)) {
            const dir = prDirOf(key.slice(prefix.length));
            return dir !== "" && (view.prDirs ?? []).includes(dir);
        }
    }
    return false;
}

// A notification's source is in view: the pane it names.
export function notificationInView(entry: { blockid?: string }, view: AgentSeenView): boolean {
    return !!view?.active && !!entry?.blockid && (view.blockIds ?? []).includes(entry.blockid);
}
