// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A Reviews card's local CI that nothing runs (#1713, FR-REV-001, FR-MC-011): Approve the commands opens the
// approve-only sheet (approving starts nothing), and Run the local CI again runs it on the PR's branch, asking for the
// approval first when the commands wait for it. Both only on the developer's click.

import { errorPhrase, phrase, type Phrase } from "../i18n/phrase";
import { ciRun, type CiRunResult } from "../mission/mission-client";
import { reviewProjectCommands } from "../mission/trust-approval";
import type { NotificationGestureResult } from "../notifications-store";

export type LocalCiDeps = {
    run: (dir: string, branch: string) => Promise<CiRunResult>;
    approve: (dir: string) => Promise<NotificationGestureResult>;
};

const Live: LocalCiDeps = {
    run: (dir, branch) => ciRun(dir, branch, false),
    approve: reviewProjectCommands,
};

function approvalError(result: NotificationGestureResult): Phrase {
    return result?.ok === false ? { error: result.error ?? "" } : null;
}

// approveCommands: null once the sheet closed, approved or not; the card follows wavesrv's next answer.
export async function approveCommands(dir: string, deps: LocalCiDeps = Live): Promise<Phrase> {
    return approvalError(await deps.approve(dir));
}

// runLocalCiAgain: null once a run started, or when the developer closed the approval sheet without approving.
export async function runLocalCiAgain(dir: string, branch: string, deps: LocalCiDeps = Live): Promise<Phrase> {
    try {
        let result = await deps.run(dir, branch);
        if (result?.untrusted != null) {
            const approval = await deps.approve(dir);
            if (!approval?.ok || !approval.resolve) {
                return approvalError(approval);
            }
            result = await deps.run(dir, branch);
        }
        return result?.run != null ? null : phrase("reviews.card.ciRun.notStarted");
    } catch (e) {
        return errorPhrase(e);
    }
}
