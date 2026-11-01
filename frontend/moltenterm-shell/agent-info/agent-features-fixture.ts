// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// For tests: wavesrv's real compatibility matrix, the copy pkg/molten/agentcontinuity's TestMatrixGoldenForInterface
// keeps equal to what the molten:agentfeatures route answers (MOLTEN_UPDATE_GOLDEN=1 rewrites it).

import { AgentFeaturesModel, type AgentFeatures, type FeatureMatrix } from "./agent-features-model";
import RealMatrixJson from "./testdata/agent-features.json";

export const RealMatrix = RealMatrixJson as FeatureMatrix;

// The real matrix with one more row, for an agent the interface has never heard of.
export function matrixWith(row: AgentFeatures): FeatureMatrix {
    return { ...RealMatrix, agents: [...RealMatrix.agents, row] };
}

export function setTestMatrix(matrix: FeatureMatrix = RealMatrix) {
    AgentFeaturesModel.getInstance().setMatrix(matrix);
}
