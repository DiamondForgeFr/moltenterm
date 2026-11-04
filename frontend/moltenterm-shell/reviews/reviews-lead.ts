// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the window does around Resume with a lead agent (#1779, FR-REV-022 AC19): it names the lead to wavesrv, which
// resolves it again against the running agents, and shows the lead's tab once the work is handed to it (the developer's
// click is the consent, nothing else asks).

import { fireAndForget } from "@/util/util";
import { showPanel } from "../review/review-panels";
import type { LeadFacts, RebaseResult } from "./reviews-model";

// Must match LeadRef in pkg/molten/review/lead.go. The CLI is its id when a sub-agent's registry gave it, else its
// name as the signature has it.
export type LeadRefWire = { firstname?: string; agent?: string; blockid?: string };

export function leadRef(lead: LeadFacts): LeadRefWire {
    return {
        ...(lead.name ? { firstname: lead.name } : {}),
        ...(lead.agent || lead.agentName ? { agent: lead.agent || lead.agentName } : {}),
        ...(lead.blockId ? { blockid: lead.blockId } : {}),
    };
}

// The lead took the work, or will once its prompt is idle or its session is up: its terminal is shown.
const ShownStatuses = new Set(["sent", "typed", "queued", "started"]);

export function leadToShow(result: RebaseResult): string {
    if (!result?.lead || !result.blockid || !ShownStatuses.has(result.status)) {
        return "";
    }
    return result.blockid;
}

export function showLead(result: RebaseResult) {
    const blockId = leadToShow(result);
    if (!blockId) {
        return;
    }
    fireAndForget(() => showPanel(blockId));
}
