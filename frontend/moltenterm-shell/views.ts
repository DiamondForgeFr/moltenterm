// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Every block view Moltenterm adds, registered by Wave's block registry in one call so new views cost no Wave edit.

import { MoltentermOnboardingView, OnboardingViewModel } from "../moltenterm-onboarding/onboarding-view";
import { BrowserViewModel, MoltentermBrowserView } from "./browser/browser-view";
import { CompanionViewModel, MoltentermCompanionView } from "./companion/companion-view";
import { CicdViewModel, MoltentermCicdView } from "./mission/cicd-view";
import { LineMapViewModel, MoltentermLineMapView } from "./mission/line-map-view";
import { MoltentermPipelineView, PipelineViewModel } from "./mission/pipeline-tab-view";
import { LegacyTimelineView, MoltentermProjectView } from "./project/project-model";
import { ProjectViewModel } from "./project/project-view";
import { MoltentermReviewAiView, ReviewAiViewModel } from "./review/review-ai-view";
import { MoltentermReviewView, ReviewViewModel } from "./review/review-view";
import { MoltentermReviewsView, ReviewsViewModel } from "./reviews/reviews-view";
import { MoltentermSessionsView, SessionsViewModel } from "./sessions/sessions-view";
import { MoltentermTipsView, TipsViewModel } from "./tips/tips-view";

export function registerMoltentermViews(registry: Map<string, ViewModelClass>) {
    registry.set(MoltentermBrowserView, BrowserViewModel);
    // wavesrv migrates saved Timeline blocks at start; one created later (a stale blockdef) shows the overview too.
    registry.set(LegacyTimelineView, ProjectViewModel);
    registry.set(MoltentermCicdView, CicdViewModel);
    registry.set(MoltentermCompanionView, CompanionViewModel);
    registry.set(MoltentermLineMapView, LineMapViewModel);
    registry.set(MoltentermProjectView, ProjectViewModel);
    registry.set(MoltentermOnboardingView, OnboardingViewModel);
    registry.set(MoltentermPipelineView, PipelineViewModel);
    registry.set(MoltentermReviewsView, ReviewsViewModel);
    registry.set(MoltentermReviewView, ReviewViewModel);
    registry.set(MoltentermReviewAiView, ReviewAiViewModel);
    registry.set(MoltentermSessionsView, SessionsViewModel);
    // Replaces Wave's tips view under its own view type, so Tips blocks saved earlier open MoltenTerm's (#534).
    registry.set(MoltentermTipsView, TipsViewModel);
}
