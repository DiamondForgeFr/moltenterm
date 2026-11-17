// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The fence of Brokk's graph block (FR-BOSS-010, DS-BOSS-009, #2246): what the window must know up front, to keep the
// block out of the words his exchange shows and to wake the brainstorm when an answer carries one. Reading and checking
// the block is brainstorm-graph-model.ts's, loaded with the brainstorm.
//
// It is part of the bubble's up-front JavaScript: it imports nothing.

// must match pkg/molten/brokksession/brief-brainstorm.md
export const GraphFence = "brokk-graph";

const OpenFence = new RegExp("^```" + GraphFence + "\\s*$");
const CloseFence = /^```\s*$/;

export function hasGraphFence(markdown: string): boolean {
    return (markdown ?? "").split(/\r?\n/).some((line) => OpenFence.test(line));
}

// His words without any graph block, a broken or unfinished one too: the developer reads his words, never the JSON.
export function withoutGraphBlocks(markdown: string): string {
    if (!hasGraphFence(markdown)) {
        return markdown ?? "";
    }
    const kept: string[] = [];
    let inBlock = false;
    for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
        if (!inBlock && OpenFence.test(line)) {
            inBlock = true;
            continue;
        }
        if (inBlock) {
            if (CloseFence.test(line)) {
                inBlock = false;
            }
            continue;
        }
        kept.push(line);
    }
    return kept
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
