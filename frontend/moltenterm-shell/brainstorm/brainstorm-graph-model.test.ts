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
    questionsOf,
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
            "an operation named with the model's text",
            JSON.stringify({ v: 1, talk: "project", ops: [{ op: "Secret plan for the launch", id: "a" }] }),
        ],
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

    it("names a known operation in its reason, and only a known one", () => {
        expect(blockProblem({ v: 1, talk: "project", ops: [{ op: "link", a: "a", b: "a" }] })).toBe(
            "operation 1 (link): a node linked to itself"
        );
        expect(blockProblem({ v: 1, talk: "project", ops: [{ op: "my secret", id: "a" }] })).toBe(
            "operation 1 (unknown op): unknown operation"
        );
    });

    it("skips the operations of later stories rather than dropping the block", () => {
        expect(
            blockProblem({ v: 1, talk: "project", ops: [{ op: "remember", text: "Likes forge-city stories" }] })
        ).toBe("");
        expect(
            blockProblem({
                v: 1,
                talk: "project",
                ops: [{ op: "propose", id: "p", text: "Hand it on", from: "c", action: "handoff" }],
            })
        ).toBe("");
    });

    // FR-BOSS-010 AC14, AC15 (#2250): his conclusion carries a valid brief, his proposal a known action, as wavesrv
    // checks them (pkg/molten/brainstorm/graph.go); a bad one drops the block, its reason quoting nothing of it.
    it("checks his conclusion's brief and his proposal's action", () => {
        const brief = {
            name: "Forge Notes",
            slug: "forge-notes",
            pitch: "A notebook that keeps a workshop's decisions.",
            problem: "Decisions made at the bench are lost.",
            users: "A small team of makers.",
        };
        const ok = { op: "conclude", id: "first-pass", text: "Clear idea", brief };
        expect(
            blockProblem({
                v: 1,
                talk: "project",
                ops: [ok, { op: "propose", id: "p", text: "Make it a project", from: "first-pass", action: "project" }],
            })
        ).toBe("");
        expect(blockProblem({ v: 1, talk: "project", ops: [{ ...ok, brief: undefined }] })).toBe(
            "operation 1 (conclude): no brief"
        );
        expect(
            blockProblem({ v: 1, talk: "project", ops: [{ ...ok, brief: { ...brief, slug: "My secret slug" } }] })
        ).toBe("operation 1 (conclude): brief slug: invalid");
        expect(blockProblem({ v: 1, talk: "project", ops: [{ ...ok, from: "Not An Id" }] })).toBe(
            "operation 1 (conclude): invalid id"
        );
        expect(
            blockProblem({
                v: 1,
                talk: "project",
                ops: [{ op: "propose", id: "p", text: "x", from: "c", action: "rockets" }],
            })
        ).toBe("operation 1 (propose): unknown action");
        expect(blockProblem({ v: 1, talk: "project", ops: [{ op: "propose", id: "p", text: "x", from: "c" }] })).toBe(
            "operation 1 (propose): unknown action"
        );
    });

    // FR-BOSS-010 AC25 (#2285): his finish goes to wavesrv with the block, which marks the brainstorm finished.
    it("keeps a block that finishes the brainstorm, alone or with nodes", () => {
        const done = readGraphBlock(
            answer("Done, it's saved.", '{"v": 1, "talk": "project", "ops": [{"op": "finish"}]}')
        );
        expect(done.problem).toBe("");
        expect(done.block.ops).toEqual([{ op: "finish" }]);
        expect(opensBrainstorm(done.block)).toBe(false);
        expect(blockProblem({ v: 1, talk: "project", ops: [...block.ops, { op: "finish" }] })).toBe("");
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

// #2248: fork, resume and forget name a title; they are checked like the rest, and read as questions.
describe("his questions about the folders (#2248)", () => {
    it("checks their title and reason", () => {
        const ok: GraphBlock = {
            v: 1,
            talk: "project",
            ops: [
                { op: "fork", title: "Parental control for games", reason: "another product" },
                { op: "resume", title: "Forge notes" },
                { op: "forget", title: "A family budget" },
            ],
        };
        expect(blockProblem(ok)).toBe("");
        expect(blockProblem({ v: 1, talk: "project", ops: [{ op: "fork" }] })).toBe("operation 1 (fork): no text");
        expect(
            blockProblem({ v: 1, talk: "project", ops: [{ op: "resume", title: "x".repeat(MaxText + 1) }] })
        ).toMatch(/^operation 1 \(resume\): text over/);
        expect(
            blockProblem({
                v: 1,
                talk: "project",
                ops: [{ op: "forget", title: "x", reason: "y".repeat(MaxText + 1) }],
            })
        ).toBe("operation 1 (forget): reason too long");
    });

    it("reads the first of each, as plain words", () => {
        const questions = questionsOf({
            v: 1,
            talk: "project",
            ops: [
                { op: "add", id: "a", kind: "idea", text: "x", from: "c" },
                { op: "resume", title: "Forge\nnotes" },
                { op: "resume", title: "Another one" },
                { op: "fork", title: "Games", reason: "another\u0007 product" },
            ],
        });
        expect(questions).toEqual({ resume: "Forge notes", fork: { title: "Games", reason: "another product" } });
        expect(questionsOf(block)).toEqual({});
    });

    it("never adds a reference node from his block", () => {
        expect(
            blockProblem({
                v: 1,
                talk: "project",
                ops: [{ op: "add", id: "r", kind: "reference", text: "x", from: "c" }],
            })
        ).toBe("operation 1 (add): unknown kind");
    });
});
