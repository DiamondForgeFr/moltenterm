// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { filterNotes, keptNoteOf, newestFirst, notesScope, ReviewNote } from "./review-notes";

function note(id: string, keptat: number, extra: Partial<ReviewNote> = {}): ReviewNote {
    return { id, title: id, explanationid: "e-" + id, markdown: "", pr: { number: 1 }, keptat, ...extra };
}

describe("kept notes (FR-REV-008)", () => {
    it("lists the newest first", () => {
        expect(newestFirst([note("a", 1), note("c", 3), note("b", 2)]).map((n) => n.id)).toEqual(["c", "b", "a"]);
        expect(newestFirst(null)).toEqual([]);
    });

    it("filters on every word, ignoring case and accents", () => {
        const notes = [
            note("a", 1, { title: "Defer unlock helper", principles: ["KISS"] }),
            note("b", 2, { markdown: "Une **tâche** idempotente", sources: ["pkg/x.go:12"] }),
            note("c", 3, { pr: { number: 42, title: "Locks" } }),
        ];
        expect(filterNotes(notes, "").map((n) => n.id)).toEqual(["a", "b", "c"]);
        expect(filterNotes(notes, "kiss DEFER").map((n) => n.id)).toEqual(["a"]);
        expect(filterNotes(notes, "tache").map((n) => n.id)).toEqual(["b"]);
        expect(filterNotes(notes, "pkg/x.go").map((n) => n.id)).toEqual(["b"]);
        expect(filterNotes(notes, "#42").map((n) => n.id)).toEqual(["c"]);
        expect(filterNotes(notes, "kiss tache")).toEqual([]);
    });

    it("finds the note kept from an answer of the PR", () => {
        const notes = [note("a", 1)];
        expect(keptNoteOf(notes, 1, "e-a")?.id).toBe("a");
        expect(keptNoteOf(notes, 2, "e-a")).toBeNull();
        expect(keptNoteOf(null, 1, "e-a")).toBeNull();
    });

    it("scopes the event like wavesrv", () => {
        expect(notesScope("Owner/Repo")).toBe("reviewnotes:owner__repo");
    });
});
