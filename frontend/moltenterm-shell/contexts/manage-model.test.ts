// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { ChecklistRow, ContextInfo, DefaultContextId } from "./context-model";
import {
    canDeleteContext,
    clampDescription,
    clampName,
    ContextDraft,
    createRequestOf,
    defaultMoveTarget,
    draftChanged,
    draftOf,
    draftProblem,
    draftWith,
    editedFields,
    isRowChecked,
    newDraft,
    NoEdits,
    toggledRow,
    updateRequestOf,
} from "./manage-model";

vi.mock("./context-store", () => ({}));

const t = (key: string) => (key === "contexts.defaultName" ? "My workshop" : key);

function row(id: string, checked: boolean): ChecklistRow {
    return { id, name: id, color: "", checked, elsewhere: "" };
}

describe("the form's draft", () => {
    it("shows a context as the window does, and the workspaces that are in it", () => {
        const draft = draftOf({ id: DefaultContextId }, [row("a", true), row("b", false), row("c", true)], t);
        expect(draft).toEqual({
            id: DefaultContextId,
            name: "My workshop",
            description: "",
            emblem: "hammer",
            shape: "v",
            checked: ["a", "c"],
        });
    });

    it("shows the shape the ribbon draws, the V point for a context that has none yet", () => {
        expect(draftOf({ id: "x", shape: "moon" }, [], t).shape).toBe("moon");
        expect(draftOf({ id: "x" }, [], t).shape).toBe("v");
        expect(draftOf({ id: "x" }, [], t, "arrow").shape).toBe("arrow");
    });

    it("starts a new context empty, with the fallback emblem and no shape until the form draws one", () => {
        expect(newDraft()).toEqual({ id: "", name: "", description: "", emblem: "folder", shape: "", checked: [] });
    });

    it("cuts a name and a description at their limits, by characters", () => {
        expect(Array.from(clampName("é".repeat(80))).length).toBe(60);
        expect(Array.from(clampDescription("d".repeat(400))).length).toBe(280);
    });
});

describe("what a save sends", () => {
    const original: ContextDraft = {
        id: "df",
        name: "DiamondForge",
        description: "Work",
        emblem: "briefcase",
        shape: "arrow",
        checked: ["a", "b"],
    };

    it("sends only the fields that changed", () => {
        expect(updateRequestOf({ ...original, name: "Forge " }, original)).toEqual({ id: "df", name: "Forge" });
        expect(updateRequestOf({ ...original, description: "" }, original)).toEqual({ id: "df", description: "" });
        expect(updateRequestOf({ ...original, emblem: "book" }, original)).toEqual({ id: "df", emblem: "book" });
        expect(updateRequestOf({ ...original, shape: "moon" }, original)).toEqual({ id: "df", shape: "moon" });
        expect(updateRequestOf({ ...original, checked: ["b", "c"] }, original)).toEqual({
            id: "df",
            addworkspaces: ["c"],
            removeworkspaces: ["a"],
        });
    });

    it("names only the workspaces the form moved, never the whole membership", () => {
        expect(updateRequestOf({ ...original, checked: ["a", "b", "c"] }, original)).toEqual({ id: "df", addworkspaces: ["c"] });
        expect(updateRequestOf({ ...original, checked: ["a"] }, original)).toEqual({ id: "df", removeworkspaces: ["b"] });
    });

    it("sends nothing when nothing changed, however the checked ids are ordered", () => {
        expect(updateRequestOf({ ...original, checked: ["b", "a"] }, original)).toBeNull();
        expect(draftChanged({ ...original, checked: ["b", "a"] }, original)).toBe(false);
    });

    it("never stores the default context's language text when its name was not touched", () => {
        const workshop = draftOf({ id: DefaultContextId }, [row("a", true)], t);
        expect(updateRequestOf({ ...workshop, emblem: "book" }, workshop)).toEqual({ id: DefaultContextId, emblem: "book" });
        expect(updateRequestOf({ ...workshop, name: "Studio" }, workshop)).toEqual({ id: DefaultContextId, name: "Studio" });
    });

    it("makes a context with its name, description, emblem, shape and checked workspaces", () => {
        expect(
            createRequestOf({
                id: "",
                name: " Book ",
                description: " My novel ",
                emblem: "book-open",
                shape: "facet",
                checked: ["a"],
            })
        ).toEqual({
            name: "Book",
            description: "My novel",
            emblem: "book-open",
            shape: "facet",
            workspaces: ["a"],
        });
        expect(draftChanged(newDraft(), newDraft())).toBe(true);
    });
});

describe("what the developer changed in the form", () => {
    const original: ContextDraft = {
        id: "df",
        name: "DiamondForge",
        description: "",
        emblem: "folder",
        shape: "v",
        checked: ["a"],
    };

    it("shows the context as it is, with the fields and the ticks he changed on top", () => {
        const rows = [row("a", true), row("b", false)];
        expect(draftWith(original, rows, NoEdits)).toEqual(original);
        const edits = toggledRow(editedFields(NoEdits, { name: "Forge" }), rows[1]);
        expect(draftWith(original, rows, edits)).toEqual({ ...original, name: "Forge", checked: ["a", "b"] });
        expect(isRowChecked(edits, rows[1])).toBe(true);
        expect(isRowChecked(toggledRow(edits, rows[1]), rows[1])).toBe(false);
    });

    it("does not take a workspace another window placed while the form was open for one he unticked", () => {
        const rowsAtOpening = [row("a", true), row("b", false)];
        const edits = toggledRow(NoEdits, rowsAtOpening[0]);
        const rowsNow = [row("a", true), row("b", true)];
        const nowOriginal = { ...original, checked: ["a", "b"] };
        const draft = draftWith(nowOriginal, rowsNow, edits);
        expect(draft.checked).toEqual(["b"]);
        expect(updateRequestOf(draft, nowOriginal)).toEqual({ id: "df", removeworkspaces: ["a"] });
    });

    it("leaves a workspace the form never showed out of the request", () => {
        const rows = [row("a", true), row("b", false)];
        const draft = draftWith(original, rows, toggledRow(NoEdits, rows[1]));
        expect(updateRequestOf(draft, original)).toEqual({ id: "df", addworkspaces: ["b"] });
    });

    it("does not send a field he did not touch, even when another window changed it", () => {
        const renamed = { ...original, name: "Renamed elsewhere" };
        const draft = draftWith(renamed, [row("a", true)], editedFields(NoEdits, { description: "Work" }));
        expect(updateRequestOf(draft, renamed)).toEqual({ id: "df", description: "Work" });
    });
});

describe("what stops a save", () => {
    const original: ContextDraft = {
        id: "df",
        name: "DiamondForge",
        description: "",
        emblem: "folder",
        shape: "v",
        checked: ["a", "b"],
    };

    it("needs a name", () => {
        expect(draftProblem({ ...original, name: "   " }, original, 2)).toBe("name");
        expect(draftProblem(newDraft(), newDraft(), 1)).toBe("name");
        expect(draftProblem({ ...original, name: "x" }, original, 2)).toBeNull();
    });

    it("keeps every workspace in the only context until another exists", () => {
        expect(draftProblem({ ...original, checked: ["a"] }, original, 1)).toBe("needsAnother");
        expect(draftProblem({ ...original, checked: ["a"] }, original, 2)).toBeNull();
        expect(draftProblem({ ...original, checked: ["a", "b", "c"] }, original, 1)).toBeNull();
    });

    it("lets a new context take workspaces even when it is the second one", () => {
        expect(draftProblem({ ...newDraft(), name: "Book", checked: ["a"] }, newDraft(), 1)).toBeNull();
    });
});

describe("deleting a context", () => {
    const contexts: ContextInfo[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

    it("moves its workspaces to the first other context by default", () => {
        expect(defaultMoveTarget(contexts, "a")).toBe("b");
        expect(defaultMoveTarget(contexts, "c")).toBe("a");
        expect(defaultMoveTarget([{ id: "a" }], "a")).toBe("");
    });

    it("never deletes the last context", () => {
        expect(canDeleteContext(contexts, "b")).toBe(true);
        expect(canDeleteContext([{ id: "a" }], "a")).toBe(false);
        expect(canDeleteContext(contexts, "gone")).toBe(false);
    });
});
