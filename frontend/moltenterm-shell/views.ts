// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Every block view Moltenterm adds, registered by Wave's block registry in one call so new views cost no Wave edit.

import { BrowserViewModel, MoltentermBrowserView } from "./browser/browser-view";
import { CompanionViewModel, MoltentermCompanionView } from "./companion/companion-view";
import { CicdViewModel, MoltentermCicdView } from "./mission/cicd-view";
import { MoltentermTimelineView, TimelineViewModel } from "./mission/timeline-view";
import { MoltentermProjectView, ProjectViewModel } from "./project/project-view";

export function registerMoltentermViews(registry: Map<string, ViewModelClass>) {
    registry.set(MoltentermBrowserView, BrowserViewModel);
    registry.set(MoltentermTimelineView, TimelineViewModel);
    registry.set(MoltentermCicdView, CicdViewModel);
    registry.set(MoltentermCompanionView, CompanionViewModel);
    registry.set(MoltentermProjectView, ProjectViewModel);
}
