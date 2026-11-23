// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Manage contexts' rules (FR-SHELL-158, #2476), apart from the dialog: the draft the form edits, what a save sends (only
// what changed), what stops it, and where a deleted context's workspaces go.

import type { TFunction } from "../i18n/i18n";
import {
    ChecklistRow,
    ContextDescriptionMaxChars,
    ContextInfo,
    contextShownEmblem,
    contextShownName,
    ContextNameMaxChars,
    FallbackContextEmblem,
    sameIds,
} from "./context-model";
import type { ContextCreateRequest, ContextUpdateRequest } from "./context-store";

export type ContextDraft = {
    // "" for a context not made yet.
    id: string;
    name: string;
    description: string;
    emblem: string;
    // The workspaces the context holds, as the checklist says.
    checked: string[];
};

export type DraftProblem = "name" | "needsAnother";

export function newDraft(): ContextDraft {
    return { id: "", name: "", description: "", emblem: FallbackContextEmblem, checked: [] };
}

// What the form shows of a context, and of the workspaces in it.
export function draftOf(context: ContextInfo, rows: readonly ChecklistRow[], t: TFunction): ContextDraft {
    return {
        id: context.id,
        name: contextShownName(context, t),
        description: context.description ?? "",
        emblem: contextShownEmblem(context),
        checked: rows.filter((r) => r.checked).map((r) => r.id),
    };
}

export function clampName(text: string): string {
    return Array.from(text).slice(0, ContextNameMaxChars).join("");
}

export function clampDescription(text: string): string {
    return Array.from(text).slice(0, ContextDescriptionMaxChars).join("");
}

// What stops a save. The only context holds every workspace, so none can leave it until another context exists.
export function draftProblem(draft: ContextDraft, original: ContextDraft, contextCount: number): DraftProblem {
    if (!draft.name.trim()) {
        return "name";
    }
    if (draft.id && contextCount < 2 && draft.checked.length < original.checked.length) {
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
    if (!sameIds(draft.checked, original.checked)) {
        req.workspaces = draft.checked;
    }
    return Object.keys(req).length > 1 ? req : null;
}

export function createRequestOf(draft: ContextDraft): ContextCreateRequest {
    return {
        name: draft.name.trim(),
        description: draft.description.trim(),
        emblem: draft.emblem,
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
