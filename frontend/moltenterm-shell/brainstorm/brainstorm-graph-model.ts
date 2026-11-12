// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How Brokk writes the graph of his thought (FR-BOSS-010, DS-BOSS-009, #2246): a fenced block `brokk-graph` at the end
// of an answer, a sibling of `brokk-actions` (pkg/molten/brokksession/brief-brainstorm.md). The window reads it with the
// rules of parseReply (brokk-exchange-model.ts): the block never shows in his words, a block still being written offers
// nothing yet, and a block that is not valid is dropped and logged without its content. wavesrv checks it again
// (pkg/molten/brainstorm/graph.go) before it grows the graph. The text of every node is plain text, never HTML.
//
// It loads with the brainstorm; the fence the window needs up front is brainstorm-fence.ts's.

import { withoutTone } from "../boss/brokk-tone";
import { GraphFence } from "./brainstorm-fence";

export { GraphFence, withoutGraphBlocks } from "./brainstorm-fence";

// The limits of DS-BOSS-009; must match pkg/molten/brainstorm/graph.go.
export const BlockVersion = 1;
export const MaxOps = 40;
export const MaxNodes = 400;
export const MaxLinks = 800;
export const MaxText = 160;
export const IdPattern = /^[a-z0-9-]{1,32}$/;

// reference: MoltenTerm's own node naming the other folder of a fork (#2248); no block adds one.
export type NodeKind =
    | "topic"
    | "question"
    | "answer"
    | "idea"
    | "theme"
    | "decision"
    | "proposal"
    | "conclusion"
    | "reference";

export const NodeKinds: NodeKind[] = [
    "topic",
    "question",
    "answer",
    "idea",
    "theme",
    "decision",
    "proposal",
    "conclusion",
    "reference",
];

// The kinds an `add` may give: the topic is the centre's, a proposal comes with `propose` (#2247).
export const AddKinds: NodeKind[] = ["question", "answer", "idea", "theme", "decision", "conclusion"];

// His questions about the folders (#2248): they never change the graph, the window asks the developer.
export const QuestionOps = ["fork", "resume", "forget"];

// The operations of later stories (#2247, #2249, #2250): skipped, not a reason to drop the block.
export const LaterOps = ["edit", "propose", "conclude", "remember"];
// The developer said the brainstorm is done (#2285): wavesrv saves it as finished, the graph does not change.
export const FinishOp = "finish";
const KnownOps = ["centre", "add", "link", ...QuestionOps, ...LaterOps, FinishOp];

export type Talk = "project" | "personal";

export type GraphOp = {
    op: string;
    id?: string;
    kind?: string;
    text?: string;
    from?: string;
    a?: string;
    b?: string;
    why?: string;
    // fork, resume and forget: the brainstorm's title, and why the talk is another project.
    title?: string;
    reason?: string;
};

export type GraphBlock = { v: number; talk: Talk; ops: GraphOp[] };

// must match pkg/molten/brainstorm/graph.go
export type BrainstormNode = {
    id: string;
    kind: NodeKind;
    text: string;
    from?: string;
    status: string;
    turn: number;
    at: number;
    pos: [number, number, number];
    // The id of the brainstorm a reference node names.
    ref?: string;
};

export type BrainstormLink = { a: string; b: string; why?: string; turn: number };

export type BrainstormGraph = {
    schema: number;
    rev: number;
    centre: string;
    nodes: BrainstormNode[];
    links: BrainstormLink[];
};

// The answer's words without the block; the block when one is complete and valid; why there is none otherwise:
// "none" (no block), "open" (still being written), "invalid" (dropped).
export type GraphRead = { text: string; block: GraphBlock; problem: "" | "none" | "open" | "invalid"; reason?: string };

const OpenFence = new RegExp("^```" + GraphFence + "\\s*$");
const CloseFence = /^```\s*$/;

// eslint-disable-next-line no-control-regex
const ControlRuns = /[\u0000-\u001f\u007f]+/g;

// One line of plain words, as wavesrv keeps it.
export function cleanText(text: string): string {
    return (text ?? "").replace(ControlRuns, " ").replace(/\s+/g, " ").trim();
}

function textProblem(text: unknown): string {
    if (typeof text !== "string") {
        return "no text";
    }
    const clean = cleanText(text);
    if (clean === "") {
        return "empty text";
    }
    return [...clean].length > MaxText ? `text over ${MaxText} characters` : "";
}

function idProblem(id: unknown): string {
    return typeof id === "string" && IdPattern.test(id) ? "" : "invalid id";
}

// Why a block's shape is refused, "" when it is valid. The reason never quotes the model's text: it is logged.
export function blockProblem(value: unknown): string {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return "not an object";
    }
    const block = value as { v?: unknown; talk?: unknown; ops?: unknown };
    if (block.v !== BlockVersion) {
        return "unknown version";
    }
    if (block.talk !== "project" && block.talk !== "personal") {
        return "unknown talk";
    }
    if (!Array.isArray(block.ops)) {
        return "no operations";
    }
    if (block.ops.length > MaxOps) {
        return `${block.ops.length} operations, over ${MaxOps}`;
    }
    for (let i = 0; i < block.ops.length; i++) {
        const op = block.ops[i] as GraphOp;
        const at = `operation ${i + 1}`;
        if (op == null || typeof op !== "object" || typeof op.op !== "string") {
            return `${at}: not an operation`;
        }
        let problem = "";
        switch (op.op) {
            case "centre":
                problem = idProblem(op.id) || textProblem(op.text);
                break;
            case "add":
                problem =
                    idProblem(op.id) ||
                    idProblem(op.from) ||
                    (AddKinds.includes(op.kind as NodeKind) ? "" : "unknown kind") ||
                    textProblem(op.text);
                break;
            case "link":
                problem =
                    idProblem(op.a) ||
                    idProblem(op.b) ||
                    (op.a === op.b ? "a node linked to itself" : "") ||
                    ([...cleanText(op.why ?? "")].length > MaxText ? "reason too long" : "");
                break;
            case "fork":
            case "resume":
            case "forget":
                problem =
                    textProblem(op.title) ||
                    ([...cleanText(op.reason ?? "")].length > MaxText ? "reason too long" : "");
                break;
            case FinishOp:
                break;
            default:
                problem = LaterOps.includes(op.op) ? "" : "unknown operation";
        }
        if (problem !== "") {
            // The model writes the op's name: only a known one is quoted in a logged reason.
            const name = KnownOps.includes(op.op) ? op.op : "unknown op";
            return `${at} (${name}): ${problem}`;
        }
    }
    return "";
}

// His answer split into his words and the graph block it ends with. Every `brokk-graph` block leaves the text, a
// broken one too: the developer reads his words, never the JSON. The last complete block is the one read.
export function readGraphBlock(markdown: string): GraphRead {
    const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");
    const kept: string[] = [];
    let body: string[] = null;
    let last: string[] = null;
    let open = false;
    for (const line of lines) {
        if (body == null) {
            if (OpenFence.test(line)) {
                body = [];
                open = true;
                continue;
            }
            kept.push(line);
            continue;
        }
        if (CloseFence.test(line)) {
            last = body;
            body = null;
            open = false;
            continue;
        }
        body.push(line);
    }
    // The marker of his tone (FR-BOSS-009, AC88, #2259) is not one of his words either.
    const text = withoutTone(
        kept
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim()
    );
    if (open && last == null) {
        return { text, block: null, problem: "open" };
    }
    if (last == null) {
        return { text, block: null, problem: "none" };
    }
    let value: unknown;
    try {
        value = JSON.parse(last.join("\n"));
    } catch {
        return { text, block: null, problem: "invalid", reason: "not JSON" };
    }
    const reason = blockProblem(value);
    if (reason !== "") {
        return { text, block: null, problem: "invalid", reason };
    }
    return { text, block: value as GraphBlock, problem: "" };
}

export function centreOf(block: GraphBlock): string {
    return block?.ops?.find((op) => op.op === "centre")?.id ?? "";
}

// His answer opens a brainstorm when it puts a central idea of a project (FR-BOSS-010 AC2): a quick question stays a
// normal exchange, and personal talk draws no graph.
export function opensBrainstorm(block: GraphBlock): boolean {
    return block != null && block.talk === "project" && centreOf(block) !== "";
}

// His questions about the folders in a block (#2248): the first fork, resume and forget it holds, their texts plain.
export type BlockQuestions = {
    fork?: { title: string; reason: string };
    resume?: string;
    forget?: string;
};

export function questionsOf(block: GraphBlock): BlockQuestions {
    const rtn: BlockQuestions = {};
    for (const op of block?.ops ?? []) {
        const title = cleanText(op.title ?? "");
        if (title === "") {
            continue;
        }
        if (op.op === "fork" && rtn.fork == null) {
            rtn.fork = { title, reason: cleanText(op.reason ?? "") };
        } else if (op.op === "resume" && rtn.resume == null) {
            rtn.resume = title;
        } else if (op.op === "forget" && rtn.forget == null) {
            rtn.forget = title;
        }
    }
    return rtn;
}

// A short stable mark of a text, so that the same answer read twice is applied once (wavesrv keeps the keys).
export function textMark(text: string): string {
    let h = 2166136261;
    for (let i = 0; i < (text ?? "").length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}
