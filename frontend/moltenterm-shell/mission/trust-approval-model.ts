// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A run refused from a terminal for untrusted commands (DS-MC-005, #1017): wavesrv publishes one notification per
// folder (pkg/molten/mission/trust_ask.go). These rules read it; the sheet is in trust-approval.tsx.

import type { MoltentermNotification } from "../notifications-model";

// must match pkg/molten/mission/trust_ask.go
export const TrustNotificationSource = "trust";
export const TrustReviewGesture = "trust:review";

// The folder whose commands wait for the developer because the terminal blockId was refused a run; "" when none.
export function trustAskOf(entries: MoltentermNotification[], blockId: string): string {
    if (!blockId || entries == null) {
        return "";
    }
    for (const entry of entries) {
        if (entry.source !== TrustNotificationSource || entry.resolved != null) {
            continue;
        }
        for (const action of entry.actions ?? []) {
            const blocks = action.args?.blockids;
            if (
                action.gesture === TrustReviewGesture &&
                typeof action.args?.dir === "string" &&
                Array.isArray(blocks) &&
                blocks.includes(blockId)
            ) {
                return action.args.dir;
            }
        }
    }
    return "";
}

// The review action of a trust notification, which clicking the notification itself runs too.
export function trustReviewAction(entry: MoltentermNotification) {
    if (entry?.source !== TrustNotificationSource) {
        return null;
    }
    return entry.actions?.find((a) => a.gesture === TrustReviewGesture) ?? null;
}
