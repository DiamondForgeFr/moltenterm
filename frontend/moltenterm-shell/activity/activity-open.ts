// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where a row of the activity popover goes (FR-BOSS-009, AC85, #2233): a click is the developer's own gesture, and the
// popover has told what the row is. An agent opens in its pane, a pull request's CI in the Integration panel, a local
// CI run in the CI/CD panel's local tab, a build in its project's tab.

import { goToAgent } from "../agent-info/agent-info-hooks";
import { openCicdTab } from "../mission/cicd-open";
import { openMoltentermView } from "../open-view";
import { openProjectOverview, showProjectTab } from "../project/project-tab";
import { MoltentermReviewsView } from "../reviews/reviews-model";
import type { ActivityTarget } from "./activity-model";

export async function openActivity(target: ActivityTarget): Promise<void> {
    switch (target?.type) {
        case "agent":
            await goToAgent(target);
            return;
        case "pr-ci":
            await openMoltentermView(MoltentermReviewsView);
            return;
        case "local-ci":
            await openCicdTab("local");
            return;
        case "build":
            if (!(await showProjectTab(target.workspaceid ?? ""))) {
                await openProjectOverview();
            }
            return;
    }
}
