// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window and wavesrv name the learning route, its commands, its workflows and its thresholds twice: this keeps the
// two lists in step (the Go file says "must match frontend/moltenterm-shell/learning/learning-model.ts").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as model from "./learning-model";

const goSource = readFileSync(join(process.cwd(), "pkg/molten/agentlearning.go"), "utf8");

function goString(name: string): string {
    const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(goSource);
    expect(match, `${name} in agentlearning.go`).not.toBeNull();
    return match[1];
}

function goNumber(name: string): number {
    const match = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`).exec(goSource);
    expect(match, `${name} in agentlearning.go`).not.toBeNull();
    return Number(match[1]);
}

describe("the learning names the window and wavesrv share", () => {
    it("agree on the route, the event and the commands", () => {
        expect(model.LearningRoute).toBe(goString("LearningRoute"));
        expect(model.LearningEvent).toBe(goString("LearningEvent"));
        expect(model.LearningAllScope).toBe(goString("LearningAllScope"));
        expect(model.LearningListCommand).toBe(goString("LearningListCommand"));
        expect(model.LearningDefaultsCommand).toBe(goString("LearningDefaultsCommand"));
        expect(model.LearningRecordCommand).toBe(goString("LearningRecordCommand"));
        expect(model.LearningForgetCommand).toBe(goString("LearningForgetCommand"));
        expect(model.LearningEditCommand).toBe(goString("LearningEditCommand"));
        expect(model.LearningResetCommand).toBe(goString("LearningResetCommand"));
    });

    it("agree on the workflows, the kinds and who records", () => {
        expect(model.WorkflowPipelineSetup).toBe(goString("LearningWorkflowPipelineSetup"));
        expect(model.WorkflowMorphDesign).toBe(goString("LearningWorkflowMorphDesign"));
        expect(model.KindAnswer).toBe(goString("LearningKindAnswer"));
        expect(model.KindSkip).toBe(goString("LearningKindSkip"));
        expect(model.KindCorrection).toBe(goString("LearningKindCorrection"));
        expect(model.KindPreference).toBe(goString("LearningKindPreference"));
        expect(model.KindDone).toBe(goString("LearningKindDone"));
        expect(model.ByView).toBe(goString("LearningByView"));
        expect(model.ByAgent).toBe(goString("LearningByAgent"));
        expect(model.ByUser).toBe(goString("LearningByUser"));
        const listed = /LearningWorkflows = \[\]string\{([^}]*)\}/.exec(goSource)[1];
        expect(listed.split(",").map((s) => s.trim())).toEqual([
            "LearningWorkflowPipelineSetup",
            "LearningWorkflowMorphDesign",
        ]);
        expect(model.LearningWorkflows).toEqual([model.WorkflowPipelineSetup, model.WorkflowMorphDesign]);
    });

    it("agree on when a step folds and how long a run label may be", () => {
        expect(model.FoldAfterSeen).toBe(goNumber("LearningFoldAfterSeen"));
        expect(model.MaxRunLabel).toBe(goNumber("LearningMaxRun"));
    });

    it("name every workflow with an interface text", () => {
        for (const workflow of model.LearningWorkflows) {
            expect(model.workflowInfo(workflow), workflow).not.toBeNull();
        }
    });
});
