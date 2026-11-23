// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How the browser agent's navigation meets the lookalike warning (#2482, FR-BRW-024 AC7). The agent module marks the
// navigations it makes and asks whether one was held; the lookalike module (emain/moltenterm-lookalike.ts) supplies the
// answers once it is installed. Until then nothing is marked and nothing is held. Kept apart so the agent module does
// not import the lookalike module's Electron and data-folder dependencies.

// The code the agent's navigation reports when it was held; wavesrv turns it into a fixed refusal
// (pkg/molten/browseragent/pages.go), and must match it.
export const LookalikeRefusalCode = "ERR_LOOKALIKE_DOMAIN";

export type AgentNavigationHooks = {
    begin: (webContentsId: number) => void;
    end: (webContentsId: number) => void;
    wasHeld: (webContentsId: number) => boolean;
};

let hooks: AgentNavigationHooks = { begin: () => {}, end: () => {}, wasHeld: () => false };

export function setAgentNavigationHooks(next: AgentNavigationHooks): void {
    hooks = next;
}

export function beginAgentNavigation(webContentsId: number): void {
    hooks.begin(webContentsId);
}

export function endAgentNavigation(webContentsId: number): void {
    hooks.end(webContentsId);
}

export function agentNavigationWasHeld(webContentsId: number): boolean {
    return hooks.wasHeld(webContentsId);
}
