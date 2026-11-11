// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { parseReply } from "../boss/brokk-exchange-model";
import {
    blockProblem,
    centreOf,
    GraphBlock,
    MaxOps,
    MaxText,
    opensBrainstorm,
    readGraphBlock,
    textMark,
    withoutGraphBlocks,
} from "./brainstorm-graph-model";

const block: GraphBlock = {
    v: 1,
    talk: "project",
    ops: [
        { op: "centre", id: "kids-video", text: "A safe video app for children" },
        { op: "add", id: "ages", kind: "question", text: "For which ages?", from: "kids-video" },
        { op: "link", a: "ages", b: "kids-video", why: "the age decides it" },
    ],
};

function answer(line: string, json: string): string {
    return `${line}\n\n\`\`\`brokk-graph\n${json}\n\`\`\``;
}

// FR-BOSS-010 AC4, AC21, DS-BOSS-009 (#2246): his block, read with the rules of parseReply.
describe("the brokk-graph block", () => {
    it("reads a complete block and keeps it out of his words", () => {
        const read = readGraphBlock(answer("Let's put it on the anvil.", JSON.stringify(block)));
        expect(read.problem).toBe("");
        expect(read.text).toBe("Let's put it on the anvil.");
        expect(read.block).toEqual(block);
        expect(centreOf(read.block)).toBe("kids-video");
        expect(opensBrainstorm(read.block)).toBe(true);
    });

    it("offers nothing while the block is still being written, and shows none of it", () => {
        const read = readGraphBlock('Thinking.\n\n```brokk-graph\n{"v": 1, "talk": "proj');
        expect(read).toEqual({ text: "Thinking.", block: null, problem: "open" });
    });

    it("says there is no block in a plain answer, which stays as it is", () => {
        expect(readGraphBlock("Ten past two.")).toEqual({ text: "Ten past two.", block: null, problem: "none" });
        expect(withoutGraphBlocks("Ten past two.\n\n```js\nx\n```")).toBe("Ten past two.\n\n```js\nx\n```");
    });

    // AC8: a bad block is dropped; it never shows, and its reason quotes none of its text.
    it.each([
        ["not JSON", "{not json"],
        ["a list", "[1, 2]"],
        ["another version", JSON.stringify({ ...block, v: 2 })],
        ["an unknown talk", JSON.stringify({ ...block, talk: "gossip" })],
        [
            "an invalid id",
            JSON.stringify({ v: 1, talk: "project", ops: [{ op: "centre", id: "Secret Idea", text: "x" }] }),
        ],
        [
            "an unknown kind",
            JSON.stringify({
                v: 1,
                talk: "project",
                ops: [{ op: "add", id: "a", kind: "rumour", text: "x", from: "b" }],
            }),
        ],
        [
            "a text too long",
            JSON.stringify({ v: 1, talk: "project", ops: [{ op: "centre", id: "a", text: "y".repeat(MaxText + 1) }] }),
        ],
        ["a node linked to itself", JSON.stringify({ v: 1, talk: "project", ops: [{ op: "link", a: "a", b: "a" }] })],
        ["an unknown operation", JSON.stringify({ v: 1, talk: "project", ops: [{ op: "delete", id: "a" }] })],
        [
            "too many operations",
            JSON.stringify({
                v: 1,
                talk: "project",
                ops: Array.from({ length: MaxOps + 1 }, (_, i) => ({
                    op: "add",
                    id: `n${i}`,
                    kind: "idea",
                    text: "x",
                    from: "c",
                })),
            }),
        ],
    ])("drops %s", (_name, json) => {
        const read = readGraphBlock(answer("His words.", json));
        expect(read.block).toBeNull();
        expect(read.problem).toBe("invalid");
        expect(read.text).toBe("His words.");
        expect(read.reason).not.toMatch(/Secret|yyy|rumour/);
    });

    it("skips the operations of later stories rather than dropping the block", () => {
        expect(blockProblem({ v: 1, talk: "project", ops: [{ op: "propose", id: "p", text: "x", from: "c" }] })).toBe(
            ""
        );
    });

    it("leaves a quick question a normal exchange, and personal talk draws nothing", () => {
        expect(opensBrainstorm(null)).toBe(false);
        expect(opensBrainstorm({ v: 1, talk: "personal", ops: block.ops })).toBe(false);
        expect(opensBrainstorm({ v: 1, talk: "project", ops: [block.ops[1]] })).toBe(false);
    });

    it("keeps his replies when the graph block comes before them", () => {
        const md = `${answer("Two paths.", JSON.stringify(block))}\n\n\`\`\`brokk-actions\n["The list", "The channels"]\n\`\`\``;
        const parsed = parseReply(md);
        expect(parsed.text).toBe("Two paths.");
        expect(parsed.actions.map((a) => a.label)).toEqual(["The list", "The channels"]);
        expect(readGraphBlock(md).block).toEqual(block);
    });

    it("never shows a graph block in the exchange, even a broken one", () => {
        expect(parseReply(answer("His words.", "{broken")).text).toBe("His words.");
        expect(parseReply('His words.\n\n```brokk-graph\n{"v":').text).toBe("His words.");
    });

    it("marks the same text the same way", () => {
        expect(textMark("abc")).toBe(textMark("abc"));
        expect(textMark("abc")).not.toBe(textMark("abd"));
    });
});
