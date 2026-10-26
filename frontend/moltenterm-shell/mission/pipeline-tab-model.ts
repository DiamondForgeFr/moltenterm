// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pipeline setup's tab (FR-MC-038, #1150): its view type and what its panels carry in their meta. Kept free of
// React and of the stepper, so the tab strip and the terminals can read them without loading the setup.

import type { StepperStep } from "./release-setup-stepper";

// must match pkg/molten/mission/pipelinetab.go
export const MoltentermPipelineView = "molten-pipeline";
export const PipelineTabCommand = "moltenmissionpipelinetab";
export const PipelinePanelMetaKey = "molten:pipeline";
export const PipelineTermMetaKey = "molten:pipelineterm";
export const PipelineTabIcon = "diagram-project";

// What the setup panel shows: the project, and the step a new tab opens at (the update opens at step 2, #1102).
export type PipelineTarget = { dir: string; project?: string; openat?: StepperStep };

export function readPipelineTarget(value: unknown): PipelineTarget {
    if (value == null || typeof value !== "object") {
        return null;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.dir !== "string" || !v.dir) {
        return null;
    }
    return {
        dir: v.dir,
        project: typeof v.project === "string" ? v.project : undefined,
        openat: typeof v.openat === "string" && v.openat ? (v.openat as StepperStep) : undefined,
    };
}
