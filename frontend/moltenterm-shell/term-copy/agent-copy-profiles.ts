// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// How each coding agent draws its terminal UI, for clean copy (FR-SHELL-017, DS-SHELL-018). The ids are the agent
// registry's (AgentKinds in pkg/molten/agentstate.go): supporting a new agent is adding a row here next to its row
// there. An agent the registry knows but this table does not gets the generic profile.

export type AgentCopyProfile = {
    id: string;
    // Glyphs an agent puts in front of a block of output (a message, a tool call, its result). At the start of a line,
    // followed by a space or the end of the line, they are UI, not text.
    gutters: string[];
    // Box-drawing characters of the frames around tool output and prompts. A line made only of them is dropped; a
    // vertical side ("│ text │") is removed when the line is not a table row.
    frames: string[];
    // Columns the agent leaves free on the right when it wraps its text. The hard-wrap rule wraps at
    // `cols - rightMargin`: too small a margin misses joins, too large a margin joins lines the agent ended.
    rightMargin: number;
    // Whether the agent wraps its own text with explicit line breaks (Ink and Ratatui TUIs do), so that rejoining
    // them is worth the heuristic.
    hardWraps: boolean;
};

const CommonFrames = ["─", "━", "│", "┃", "╭", "╮", "╰", "╯", "┌", "┐", "└", "┘", "╌", "┄"];

export const GenericCopyProfile: AgentCopyProfile = {
    id: "",
    gutters: [],
    frames: [],
    rightMargin: 0,
    hardWraps: false,
};

export const AgentCopyProfiles: AgentCopyProfile[] = [
    {
        id: "claude",
        // ⏺/● start a message or a tool call, ⎿ its result; ✻ ✶ ✳ ✢ · are the spinner of a running turn.
        gutters: ["⏺", "●", "⎿", "✻", "✶", "✳", "✢", "✽"],
        frames: CommonFrames,
        rightMargin: 0,
        hardWraps: true,
    },
    {
        id: "codex",
        // • starts a message or a command, └ its output, › the prompt.
        gutters: ["•", "└", "›", "■"],
        frames: CommonFrames,
        rightMargin: 0,
        hardWraps: true,
    },
    {
        id: "gemini",
        gutters: ["✦", "✓", "✕", "⊷"],
        frames: CommonFrames,
        rightMargin: 0,
        hardWraps: true,
    },
    {
        id: "opencode",
        gutters: ["┃", "◆", "●"],
        frames: CommonFrames,
        rightMargin: 0,
        hardWraps: true,
    },
];

export function agentCopyProfile(agentId: string): AgentCopyProfile {
    if (!agentId) {
        return GenericCopyProfile;
    }
    return AgentCopyProfiles.find((p) => p.id === agentId) ?? GenericCopyProfile;
}
