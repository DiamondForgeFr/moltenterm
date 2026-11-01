// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// For tests: wavesrv's real compatibility matrix, the build's copy pkg/molten/agentcontinuity's
// TestMatrixGolden keeps equal to what the molten:agentfeatures route answers (MOLTENTERM_UPDATE_GOLDEN=1
// rewrites it).

import { AgentFeaturesModel, BuiltMatrix, type AgentFeatures, type FeatureMatrix } from "./agent-features-model";

export const RealMatrix = BuiltMatrix;

// The real matrix with one more row, for an agent the interface has never heard of.
export function matrixWith(row: AgentFeatures): FeatureMatrix {
    return { ...RealMatrix, agents: [...RealMatrix.agents, row] };
}

export function setTestMatrix(matrix: FeatureMatrix = RealMatrix) {
    AgentFeaturesModel.getInstance().setMatrix(matrix);
}
