// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The icon tile of each section's block (FR-SHELL-018, #2441): the block of the dashboard, and the ghost the arranging
// mode draws in its place when it has nothing to show or is hidden (#2467), carry the same one.

import { Bot, ClipboardCheck, FileText, Flag, FolderGit2, Gauge, MessagesSquare } from "lucide-react";
import { StateMark } from "../state-mark";
import type { CompanionSectionId } from "./companion-layout";

export const SectionTiles: Record<CompanionSectionId, React.ReactNode> = {
    permission: <StateMark kind="waiting" />,
    tasks: <Flag strokeWidth={2} aria-hidden />,
    agents: <Bot strokeWidth={2} aria-hidden />,
    usage: <Gauge strokeWidth={2} aria-hidden />,
    topics: <MessagesSquare strokeWidth={2} aria-hidden />,
    answer: <FileText strokeWidth={2} aria-hidden />,
    task: <ClipboardCheck strokeWidth={2} aria-hidden />,
    files: <FolderGit2 strokeWidth={2} aria-hidden />,
};
