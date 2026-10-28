// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { ProjectLogoMetaKey } from "../workspace-project";

// The project's logo at the left of the workspace title (#1278): the one the workspace keeps for its linked project,
// "" when it has none, and then nothing stands in its place.
export function workspaceHeaderLogo(ws: Workspace): string {
    const logo = (ws?.meta as Record<string, unknown>)?.[ProjectLogoMetaKey];
    return typeof logo === "string" ? logo.trim() : "";
}
