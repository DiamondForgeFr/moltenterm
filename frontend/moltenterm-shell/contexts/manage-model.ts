// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Manage contexts' rules (FR-SHELL-158, #2476), apart from the dialog: the draft the form edits, what a save sends (only
// what changed), what stops it, and where a deleted context's workspaces go.

import type { TFunction } from "../i18n/i18n";
import {
    ChecklistRow,
    ContextDescriptionMaxChars,
    ContextInfo,
    ContextNameMaxChars,
    contextShownEmblem,
    contextShownName,
    FallbackContextEmblem,
} from "./context-model";
import type { ContextCreateRequest, ContextUpdateRequest } from "./context-store";
import { DefaultShapeId } from "./ribbon-shapes";

export type ContextDraft = {
    // "" for a context not made yet.
    id: string;
    name: string;
    description: string;
    emblem: string;
    // The end shape of the ribbon (ribbon-shapes.ts); "" until the form draws one for a context not made yet.
    shape: string;
    // The optional folder that bounds the context's workspaces (#2516, #2518); "" for none.
    folder: string;
    // The workspaces the context holds, as the checklist says.
    checked: string[];
};

export type DraftProblem = "name" | "needsAnother";

export function newDraft(): ContextDraft {
    return { id: "", name: "", description: "", emblem: FallbackContextEmblem, shape: "", folder: "", checked: [] };
}

// What the form shows of a context, and of the workspaces in it. `shape` is the one its ribbon draws now (a context the
// migration has not reached yet draws the V point).
export function draftOf(
    context: ContextInfo,
    rows: readonly ChecklistRow[],
    t: TFunction,
    shape: string = context.shape || DefaultShapeId
): ContextDraft {
    return {
        id: context.id,
        name: contextShownName(context, t),
        description: context.description ?? "",
        emblem: contextShownEmblem(context),
        shape,
        folder: context.folder ?? "",
        checked: rows.filter((r) => r.checked).map((r) => r.id),
    };
}

export function clampName(text: string): string {
    return Array.from(text).slice(0, ContextNameMaxChars).join("");
}

export function clampDescription(text: string): string {
    return Array.from(text).slice(0, ContextDescriptionMaxChars).join("");
}

// What the developer changed in the form, apart from the context itself: the fields he typed in, and the state he gave
// to each workspace he ticked or unticked. Everything else is read from the context as it is now, so a workspace that
// comes into the context while the form is open (another window placed it) is not mistaken for one he unticked.
export type DraftEdits = {
    fields: Partial<Pick<ContextDraft, "name" | "description" | "emblem" | "shape" | "folder">>;
    picks: Record<string, boolean>;
};

export const NoEdits: DraftEdits = { fields: {}, picks: {} };

export function editedFields(edits: DraftEdits, patch: DraftEdits["fields"]): DraftEdits {
    return { ...edits, fields: { ...edits.fields, ...patch } };
}

export function isRowChecked(edits: DraftEdits, row: ChecklistRow): boolean {
    return edits.picks[row.id] ?? row.checked;
}

export function toggledRow(edits: DraftEdits, row: ChecklistRow): DraftEdits {
    return { ...edits, picks: { ...edits.picks, [row.id]: !isRowChecked(edits, row) } };
}

// The draft the form shows: the context as it is now, with what the developer changed on top.
export function draftWith(original: ContextDraft, rows: readonly ChecklistRow[], edits: DraftEdits): ContextDraft {
    return {
        ...original,
        ...edits.fields,
        checked: rows.filter((r) => isRowChecked(edits, r)).map((r) => r.id),
    };
}

export type MembershipChange = { add: string[]; remove: string[] };

// The workspaces the draft moves: the ones it ticks that the context did not hold, and the ones it unticks that the
// context held. A workspace on neither list is not touched.
export function membershipChange(draft: ContextDraft, original: ContextDraft): MembershipChange {
    return {
        add: draft.checked.filter((id) => !original.checked.includes(id)),
        remove: original.checked.filter((id) => !draft.checked.includes(id)),
    };
}

// What stops a save. The only context holds every workspace, so none can leave it until another context exists.
export function draftProblem(draft: ContextDraft, original: ContextDraft, contextCount: number): DraftProblem {
    if (!draft.name.trim()) {
        return "name";
    }
    if (draft.id && contextCount < 2 && membershipChange(draft, original).remove.length > 0) {
        return "needsAnother";
    }
    return null;
}

// The update a save sends: the fields that changed, nothing when none did. The name of the default context is its
// language's own text until the developer changes it, so an untouched name is never stored.
export function updateRequestOf(draft: ContextDraft, original: ContextDraft): ContextUpdateRequest {
    const req: ContextUpdateRequest = { id: draft.id };
    const name = draft.name.trim();
    if (name !== original.name.trim()) {
        req.name = name;
    }
    if (draft.description.trim() !== original.description.trim()) {
        req.description = draft.description.trim();
    }
    if (draft.emblem !== original.emblem) {
        req.emblem = draft.emblem;
    }
    if (draft.shape !== original.shape) {
        req.shape = draft.shape;
    }
    if (draft.folder !== original.folder) {
        req.folder = draft.folder;
    }
    const { add, remove } = membershipChange(draft, original);
    if (add.length > 0) {
        req.addworkspaces = add;
    }
    if (remove.length > 0) {
        req.removeworkspaces = remove;
    }
    return Object.keys(req).length > 1 ? req : null;
}

// A new context is made with its name, description, emblem and workspaces; its folder is set once it exists (the create
// request carries none), by the one command that sets a context's folder.
export function createRequestOf(draft: ContextDraft): ContextCreateRequest {
    return {
        name: draft.name.trim(),
        description: draft.description.trim(),
        emblem: draft.emblem,
        shape: draft.shape,
        workspaces: draft.checked,
    };
}

export function draftChanged(draft: ContextDraft, original: ContextDraft): boolean {
    return draft.id === "" || updateRequestOf(draft, original) != null;
}

// Where a deleted context's workspaces go by default: the first other context.
export function defaultMoveTarget(contexts: readonly ContextInfo[], deletedId: string): string {
    return contexts.find((c) => c.id !== deletedId)?.id ?? "";
}

export function canDeleteContext(contexts: readonly ContextInfo[], id: string): boolean {
    return contexts.length > 1 && contexts.some((c) => c.id === id);
}
