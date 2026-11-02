// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the pipeline setup's tab (#1150) gives the screens it hosts: the project, the setup panel's block, and
// askAgent, the one way a screen asks the developer's agent for help (pipeline-agent.ts): it opens or reuses the
// terminal on the left, starts the agent there when none runs, and hands it the context. A step's "Question" and the
// panel's "Ask for help" call it on the developer's click (#1152); outside the tab there is none.

import { createContext, useContext } from "react";
import type { PipelineAskRequest, PipelineAskResult } from "./pipeline-agent";

export type PipelineTabValue = {
    dir: string;
    project: string;
    panelBlockId: string;
    askAgent: (req: PipelineAskRequest) => Promise<PipelineAskResult>;
};

export const PipelineTabContext = createContext<PipelineTabValue>(null);

export function usePipelineTab(): PipelineTabValue {
    return useContext(PipelineTabContext);
}

// The tab's askAgent, undefined outside the tab.
export function useAskAgent(): (req: PipelineAskRequest) => Promise<PipelineAskResult> {
    return useContext(PipelineTabContext)?.askAgent;
}
