// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agent note's rules (FR-SHELL-084, #2008): one line of at most 80 characters, an empty note is no note, the same
// menu on every row kind, Enter saves and Escape cancels.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    AgentNotesMetaKey,
    MaxNoteLength,
    NarrowRowPx,
    normalizeNote,
    noteKey,
    noteKeyAction,
    noteMenuPlan,
    readNotes,
    withNote,
} from "./agent-note-model";

describe("the note's text", () => {
    it("is one trimmed line: line breaks and runs of spaces become one space", () => {
        expect(normalizeNote("  audit sécu nov6,\n ne pas relancer \t")).toBe("audit sécu nov6, ne pas relancer");
    });

    it("holds at most 80 characters, cut by character so an accent or an emoji is never split", () => {
        const long = "é".repeat(120);
        expect(Array.from(normalizeNote(long))).toHaveLength(80);
        expect(MaxNoteLength).toBe(80);
        const emojis = "🔥".repeat(100);
        expect(Array.from(normalizeNote(emojis))).toHaveLength(80);
        expect(normalizeNote("a".repeat(79) + " b")).toBe("a".repeat(79));
        expect(normalizeNote("x".repeat(80))).toBe("x".repeat(80));
    });

    it("is empty for nothing, for spaces, and for what is not text", () => {
        for (const raw of ["", "   \n\t", null, undefined, 4, {}, ["a"]]) {
            expect(normalizeNote(raw)).toBe("");
        }
    });
});

describe("the notes the workspace holds", () => {
    it("reads what is stored, text only, and keeps nothing of another shape", () => {
        expect(readNotes({ b1: "audit", b2: "  revoir demain  ", "b1/s1": "relire" })).toEqual({
            b1: "audit",
            b2: "revoir demain",
            "b1/s1": "relire",
        });
        expect(readNotes({ b1: "", b2: 3, b3: null, b4: "ok" })).toEqual({ b4: "ok" });
        for (const raw of [null, undefined, "text", 3, ["b1"]]) {
            expect(readNotes(raw)).toEqual({});
        }
    });

    it("cuts a stored note that is too long, whoever wrote it", () => {
        expect(readNotes({ b1: "x".repeat(200) }).b1).toHaveLength(80);
    });

    it("sets, replaces and removes one note without touching the others or the map it was given", () => {
        const notes = { b1: "audit", b2: "demain" };
        const added = withNote(notes, "b3", "gold");
        expect(added).toEqual({ b1: "audit", b2: "demain", b3: "gold" });
        expect(withNote(added, "b1", "autre")).toEqual({ b1: "autre", b2: "demain", b3: "gold" });
        expect(withNote(notes, "b2", "")).toEqual({ b1: "audit" });
        expect(withNote(notes, "b2", "  \n ")).toEqual({ b1: "audit" });
        expect(notes).toEqual({ b1: "audit", b2: "demain" });
        expect(withNote(null, "b1", "x")).toEqual({ b1: "x" });
    });

    it("keys an agent by its terminal and a sub-agent under it", () => {
        expect(noteKey("blk")).toBe("blk");
        expect(noteKey("blk", "sub-1")).toBe("blk/sub-1");
        expect(noteKey("blk", "")).toBe("blk");
    });

    it("is kept under the key the backend drops it by", () => {
        const go = fs.readFileSync(path.resolve(__dirname, "../../../pkg/molten/agentstate.go"), "utf8");
        expect(go).toContain(`AgentNotesMetaKey = "${AgentNotesMetaKey}"`);
    });
});

describe("the menu", () => {
    it("adds when there is no note, edits and removes when there is one", () => {
        expect(noteMenuPlan(false)).toEqual({ add: true, edit: false, remove: false });
        expect(noteMenuPlan(true)).toEqual({ add: false, edit: true, remove: true });
    });
});

describe("the field's keys", () => {
    it("saves on Enter and cancels on Escape", () => {
        expect(noteKeyAction({ key: "Enter" })).toBe("save");
        expect(noteKeyAction({ key: "Escape" })).toBe("cancel");
    });

    it("leaves every other key, and the Enter that ends an input method's composition, to the field", () => {
        for (const key of ["a", " ", "Tab", "ArrowLeft", "Backspace"]) {
            expect(noteKeyAction({ key })).toBeNull();
        }
        expect(noteKeyAction({ key: "Enter", isComposing: true })).toBeNull();
        expect(noteKeyAction({ key: "Escape", isComposing: true })).toBeNull();
    });
});

describe("the narrow row", () => {
    it("is the width the stylesheet's container query switches the note to its glyph at", () => {
        const css = fs.readFileSync(path.resolve(__dirname, "sidebar-agents.css"), "utf8");
        expect(css).toContain(`@container mtrow (max-width: ${NarrowRowPx}px)`);
    });
});
