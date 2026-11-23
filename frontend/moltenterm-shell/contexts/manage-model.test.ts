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
    newDraft,
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
            checked: ["a", "c"],
        });
    });

    it("starts a new context empty, with the fallback emblem", () => {
        expect(newDraft()).toEqual({ id: "", name: "", description: "", emblem: "folder", checked: [] });
    });

    it("cuts a name and a description at their limits, by characters", () => {
        expect(Array.from(clampName("é".repeat(80))).length).toBe(60);
        expect(Array.from(clampDescription("d".repeat(400))).length).toBe(280);
    });
});

describe("what a save sends", () => {
    const original: ContextDraft = { id: "df", name: "DiamondForge", description: "Work", emblem: "briefcase", checked: ["a", "b"] };

    it("sends only the fields that changed", () => {
        expect(updateRequestOf({ ...original, name: "Forge " }, original)).toEqual({ id: "df", name: "Forge" });
        expect(updateRequestOf({ ...original, description: "" }, original)).toEqual({ id: "df", description: "" });
        expect(updateRequestOf({ ...original, emblem: "book" }, original)).toEqual({ id: "df", emblem: "book" });
        expect(updateRequestOf({ ...original, checked: ["b", "c"] }, original)).toEqual({
            id: "df",
            workspaces: ["b", "c"],
        });
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

    it("makes a context with its name, description, emblem and checked workspaces", () => {
        expect(createRequestOf({ id: "", name: " Book ", description: " My novel ", emblem: "book-open", checked: ["a"] })).toEqual({
            name: "Book",
            description: "My novel",
            emblem: "book-open",
            workspaces: ["a"],
        });
        expect(draftChanged(newDraft(), newDraft())).toBe(true);
    });
});

describe("what stops a save", () => {
    const original: ContextDraft = { id: "df", name: "DiamondForge", description: "", emblem: "folder", checked: ["a", "b"] };

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
