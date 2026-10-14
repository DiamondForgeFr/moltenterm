// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// `molten review open|publish|merge|restart` (FR-REV-014): a local terminal asks the window of its workspace, through
// wavesrv (pkg/molten/review/cli.go), to open a PR's Review tab and, for publish, merge and restart, its Publish,
// Validate or Restart work sheet. The window does what a click on the Reviews row then on the sheet's button would: it
// reads the PR from the Reviews data, opens the tab, and leaves the sheet's request to the tab's page
// (review-sheet-request.ts). It never posts, merges nor restarts the work: that stays the developer's click in the sheet.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { fireAndForget } from "@/util/util";
import { requestReviewSheet, ReviewSheetRequest } from "../review/review-sheet-request";
import { reviewsGet } from "./reviews-client";
import { ReviewPr, ReviewsAnswer } from "./reviews-model";
import { openPullRequestTab } from "./reviews-store";

// must match pkg/molten/review/cli.go
export const ReviewHandoffEvent = "molten:review:handoff";

export type ReviewHandoffAction = "open" | "publish" | "merge" | "restart";

export type ReviewHandoff = { id: string; action: ReviewHandoffAction; dir: string; number: number; at: number };

export type ReviewHandoffDeps = {
    reviews: (dir: string) => Promise<ReviewsAnswer>;
    // Returns the PR's Review tab in the workspace, created the first time (the row's click).
    openTab: (workspaceId: string, dir: string, pr: ReviewPr, repo: string) => Promise<string>;
    requestSheet: (tabId: string, request: ReviewSheetRequest) => Promise<void>;
    showTab: (tabId: string) => void;
};

const handled = new Set<string>();

const DefaultDeps: ReviewHandoffDeps = {
    reviews: (dir) => reviewsGet(dir),
    openTab: openPullRequestTab,
    requestSheet: requestReviewSheet,
    showTab: (tabId) => getApi().setActiveTab(tabId),
};

export function readHandoff(data: any): ReviewHandoff {
    const actions: ReviewHandoffAction[] = ["open", "publish", "merge", "restart"];
    if (data == null || typeof data.id !== "string" || !actions.includes(data.action)) {
        return null;
    }
    if (typeof data.dir !== "string" || !data.dir || !Number.isInteger(data.number) || data.number <= 0) {
        return null;
    }
    return data as ReviewHandoff;
}

// runReviewHandoff opens the PR's Review tab and leaves it the sheet the terminal asked for; true when it did.
export async function runReviewHandoff(
    h: ReviewHandoff,
    workspaceId: string,
    deps: ReviewHandoffDeps = DefaultDeps
): Promise<boolean> {
    const answer = await deps.reviews(h.dir);
    const pr = [...(answer?.ready ?? []), ...(answer?.drafts ?? [])].find((p) => p.number === h.number);
    if (pr == null || !answer.repo || !workspaceId) {
        return false;
    }
    const tabId = await deps.openTab(workspaceId, h.dir, pr, answer.repo);
    if (!tabId) {
        return false;
    }
    if (h.action !== "open") {
        await deps.requestSheet(tabId, { id: h.id, action: h.action, at: Date.now() });
    }
    deps.showTab(tabId);
    return true;
}

// Every tab of a window is a page with its own rail; only the page shown acts on a handoff, once.
function isShownPage(): boolean {
    const workspace = globalStore.get(atoms.workspace);
    return workspace != null && workspace.activetabid === globalStore.get(atoms.staticTabId);
}

// installReviewHandoff listens for the handoffs of the window's workspace; the returned function stops it.
export function installReviewHandoff(workspaceId: string): () => void {
    if (!workspaceId) {
        return () => {};
    }
    return waveEventSubscribeSingle({
        eventType: ReviewHandoffEvent as WaveEventName,
        scope: workspaceId,
        handler: (event) => {
            const h = readHandoff(event.data);
            if (h == null || handled.has(h.id) || !isShownPage()) {
                return;
            }
            handled.add(h.id);
            fireAndForget(async () => {
                await runReviewHandoff(h, workspaceId);
            });
        },
    });
}
