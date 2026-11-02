// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The AI icon of the AI panel (blockutil.tsx, waveai.tsx). A terminal shows it while an agent runs in it, and the
// agent rows of the launcher and the new view chooser show it, whatever the agent's CLI (#1257). In its own file so
// the palette, the terminal and the tab identity share it without importing each other.
export const AiIcon = "sparkles";
export const TerminalIcon = "terminal";

// The icon of a terminal panel: the AI icon while an agent runs in it, else the terminal glyph.
export function terminalIcon(agentRunning: boolean): string {
    return agentRunning ? AiIcon : TerminalIcon;
}
