// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rules of the living graph in a view (FR-BOSS-010 AC26 to AC28, DS-BOSS-009, #2247), pure so that they are tested
// without a window: what a plate's menu offers, the note of the developer's changes that goes before their next message,
// which change the layer's Undo bar offers, and which one Ctrl/⌘ + Z puts back. wavesrv applies and keeps the changes
// (pkg/molten/brainstorm/edit.go, history.go); the view only reads its history.

import type { HistoryNote, NoteNode } from "./brainstorm-boot";
import { AddKinds, BrainstormNode, cleanText, MaxText, NodeKind } from "./brainstorm-graph-model";

// How long the layer offers to put a removed plate back (AC27).
export const UndoOfferMs = 5000;

// The changes whose plates leave the graph: the bar offers to put them back, the developer's and Brokk's alike.
const LeavingOps = ["remove", "merge"];

export type Translate = (key: string, vars?: Record<string, unknown>) => string;

// The developer's changes Brokk has not been told of yet: theirs, neither told nor undone.
export function untold(history: HistoryNote[]): HistoryNote[] {
    return (history ?? []).filter((note) => note?.by === "you" && !note.told && !note.undone);
}

// A node as a change names it: its text and its id, which is how Brokk names it.
function named(node: NoteNode, t: Translate): string {
    if (node == null) {
        return "";
    }
    return node.text ? t("boss.brainstorm.edits.node", { text: node.text, id: node.id }) : node.id;
}

// One change in the developer's words.
export function changeLine(note: HistoryNote, t: Translate, kindLabel: (kind: string) => string): string {
    const [a, b] = note?.nodes ?? [];
    switch (note?.op) {
        case "remove":
            return t("boss.brainstorm.edits.remove", { node: named(a, t) });
        case "edit":
            return t("boss.brainstorm.edits.edit", { id: a?.id ?? "", text: a?.text ?? "" });
        case "retype":
            return t("boss.brainstorm.edits.retype", { node: named(a, t), kind: kindLabel(a?.kind ?? "") });
        case "link":
            return t("boss.brainstorm.edits.link", { a: named(a, t), b: named(b, t) });
        case "unlink":
            return t("boss.brainstorm.edits.unlink", { a: named(a, t), b: named(b, t) });
        case "undo":
            if (a == null) {
                return "";
            }
            return LeavingOps.includes(note.refop ?? "")
                ? t("boss.brainstorm.edits.restore", { node: named(a, t) })
                : t("boss.brainstorm.edits.revert", { node: named(a, t) });
    }
    return "";
}

// The note before the developer's next message (AC27): their changes not told yet, and the last line it tells. Empty
// when there are none.
export type ChangesNote = { text: string; seq: number };

export const NoNote: ChangesNote = { text: "", seq: 0 };

export function changesNote(history: HistoryNote[], t: Translate, kindLabel: (kind: string) => string): ChangesNote {
    const notes = untold(history);
    const lines = notes.map((note) => changeLine(note, t, kindLabel)).filter((line) => line !== "");
    if (lines.length === 0) {
        return NoNote;
    }
    return {
        text: t("boss.brainstorm.edits.note", { changes: lines.join(t("boss.brainstorm.edits.join")) }),
        seq: Math.max(...notes.map((note) => note.seq)),
    };
}

// The words before the developer's next message with the note of their changes in place of the one before; the
// brainstorm's own lead ("Brainstorm:") stays first.
export function withNote(lead: string, before: string, note: string): string {
    let base = lead ?? "";
    if (before !== "" && base.endsWith(before)) {
        base = base.slice(0, base.length - before.length).trimEnd();
    }
    if (note === "") {
        return base;
    }
    return base === "" ? note : `${base} ${note}`;
}

// The note of a change that went with this message: the newest note the message carries.
export function toldBy(message: string, notes: ChangesNote[]): ChangesNote {
    for (let i = (notes?.length ?? 0) - 1; i >= 0; i--) {
        if (notes[i].text !== "" && (message ?? "").includes(notes[i].text)) {
            return notes[i];
        }
    }
    return null;
}

// The newest history line.
export function lastSeq(history: HistoryNote[]): number {
    return (history ?? []).reduce((max, note) => Math.max(max, note?.seq ?? 0), 0);
}

// What the layer's Undo bar offers after lines up to `seen`: the newest removal or merge since, still undoable, the
// developer's or Brokk's (AC27). Null for none.
export function undoOffer(history: HistoryNote[], seen: number): HistoryNote {
    const fresh = (history ?? []).filter((note) => note.seq > seen && LeavingOps.includes(note.op) && note.undoable);
    return fresh[fresh.length - 1] ?? null;
}

// Ctrl/⌘ + Z on the graph: the developer's last change that can still be put back, after a reload too (AC28).
export function lastOwnChange(history: HistoryNote[]): HistoryNote {
    const list = history ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
        const note = list[i];
        if (note.by === "you" && note.op !== "undo" && !note.undone) {
            return note.undoable ? note : null;
        }
    }
    return null;
}

// What a plate's menu offers (AC27): Edit text (also the centre's title), Change kind among the kinds of an add, Remove
// and Link to…. The centre is never retyped nor removed, and a reference node (the other folder of a fork) is
// MoltenTerm's own.
export type PlateMenu = { edit: boolean; kinds: NodeKind[]; current: NodeKind; remove: boolean; link: boolean };

export function plateMenuOf(node: BrainstormNode, centre: string): PlateMenu {
    if (node == null) {
        return null;
    }
    const reference = node.kind === "reference";
    const isCentre = node.id === centre;
    return {
        edit: !reference,
        kinds: isCentre || reference ? [] : AddKinds,
        current: node.kind,
        remove: !isCentre && !reference,
        link: !reference,
    };
}

// The text the developer typed into a plate, as wavesrv keeps it: one plain line of at most MaxText characters; "" for
// nothing to save.
export function typedText(text: string): string {
    return [...cleanText(text ?? "")].slice(0, MaxText).join("");
}

// A key in a plate's text while the developer edits it: Enter saves, Escape cancels (and never leaves the brainstorm),
// Shift+Enter is not a new line (a node is one line).
export function editKey(input: { key: string; isComposing?: boolean }): "save" | "cancel" | null {
    if (input.isComposing) {
        return null;
    }
    if (input.key === "Enter") {
        return "save";
    }
    if (input.key === "Escape") {
        return "cancel";
    }
    return null;
}

// Ctrl/⌘ + Z (not with Shift, which redoes elsewhere).
export function isUndoKey(input: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
}): boolean {
    return (input.ctrlKey || input.metaKey) && !input.shiftKey && !input.altKey && input.key.toLowerCase() === "z";
}

// The outline of the graph (AC20): a tree walked with the keyboard, the centre first, each node's children in the order
// they came. Up and Down go to the node before and after in that order, Left to the parent, Right to the first child,
// Home and End to the first and the last.
export function outlineOrder(nodes: BrainstormNode[], centre: string): string[] {
    const children = new Map<string, string[]>();
    for (const node of nodes ?? []) {
        if (node.from) {
            children.set(node.from, [...(children.get(node.from) ?? []), node.id]);
        }
    }
    const out: string[] = [];
    const visit = (id: string) => {
        out.push(id);
        for (const child of children.get(id) ?? []) {
            visit(child);
        }
    };
    if (centre) {
        visit(centre);
    }
    return out;
}

export function outlineStep(nodes: BrainstormNode[], centre: string, from: string, key: string): string {
    const order = outlineOrder(nodes, centre);
    if (order.length === 0) {
        return null;
    }
    const at = order.indexOf(from);
    const node = (nodes ?? []).find((n) => n.id === from);
    switch (key) {
        case "ArrowDown":
            return at < 0 ? order[0] : order[Math.min(order.length - 1, at + 1)];
        case "ArrowUp":
            return at < 0 ? order[0] : order[Math.max(0, at - 1)];
        case "ArrowLeft":
            return node?.from || from;
        case "ArrowRight":
            return (nodes ?? []).find((n) => n.from === from)?.id ?? from;
        case "Home":
            return order[0];
        case "End":
            return order[order.length - 1];
    }
    return null;
}
