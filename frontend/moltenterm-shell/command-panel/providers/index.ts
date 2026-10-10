// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The command panel's built-in providers, registered once when the panel host mounts. The Agent section (#402,
// FR-SHELL-048) is agent.ts, { kind: "agent", needs: ["terminal", "agent:*"] }, for the agents with a command table
// (agent-commands.ts); an action with awaitResult returns a PanelFeedback to keep the panel open.
//
// Extension points left for the stories that follow (Epic #397):
// - MoltenTerm (#403, FR-SHELL-049): providers { kind: "molten" } for MoltenTerm's own actions on any panel, and
//   { kind: "widget", needs: ["view:molten-companion"] } (line map, CI/CD, project, Sessions) for their options;
//   an item whose feature has not shipped is left out, not disabled.
// - Browser (#405, FR-SHELL-051): { kind: "widget", needs: ["browser"] }, plus an "Agent control" section while an
//   agent drives the page.
// A kind with no matching provider shows nothing: sections are ordered by kind, so adding one never moves the others.

import { registerCommandProvider } from "../panel-registry";
import { AgentProvider } from "./agent";
import { DeveloperProvider } from "./developer";
import { MoltenProviders } from "./molten";
import { PreviewProvider } from "./preview";
import { TerminalProvider } from "./terminal";
import { WaveMenuProvider } from "./wave";

let registered = false;

export function registerBuiltinCommandProviders() {
    if (registered) {
        return;
    }
    registered = true;
    registerCommandProvider(AgentProvider);
    registerCommandProvider(TerminalProvider);
    registerCommandProvider(PreviewProvider);
    registerCommandProvider(WaveMenuProvider);
    registerCommandProvider(DeveloperProvider);
    MoltenProviders.forEach((p) => registerCommandProvider(p));
}
