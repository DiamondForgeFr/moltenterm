// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A short note on an agent of the sidebar (FR-SHELL-084, #2008): "audit sécu nov6, ne pas relancer". The developer's
// own memo of why an agent is there; it is never sent to the agent. Notes live in the workspace's meta, by agent
// terminal: a terminal reads the meta of its own workspace's blocks but never the workspace's (pkg/molten/metaguard).

// must match AgentNotesMetaKey in pkg/molten/agentstate.go
export const AgentNotesMetaKey = "molten:agentnotes";
export const MaxNoteLength = 80;

export type AgentNotes = Record<string, string>;

// What a note is attached to. An agent row and the linked-agent row of that agent share the agent's note; a sub-agent
// has its own, kept with its parent's terminal.
export type NoteRowKind = "agent" | "sub" | "linked";

const SubSeparator = "/";

export function noteKey(blockId: string, subId?: string): string {
    return subId ? `${blockId}${SubSeparator}${subId}` : blockId;
}

// The note as it is kept: one line, trimmed, at most MaxNoteLength characters (by character, so an accent or an emoji
// is never cut in two). Empty means no note.
export function normalizeNote(raw: unknown): string {
    if (typeof raw !== "string") {
        return "";
    }
    const oneLine = raw.replace(/\s+/g, " ").trim();
    return Array.from(oneLine).slice(0, MaxNoteLength).join("").trimEnd();
}

export function readNotes(raw: unknown): AgentNotes {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const rtn: AgentNotes = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const text = normalizeNote(value);
        if (key !== "" && text !== "") {
            rtn[key] = text;
        }
    }
    return rtn;
}

// The map with one note set; an empty note removes it.
export function withNote(notes: AgentNotes, key: string, text: string): AgentNotes {
    const { [key]: _old, ...rest } = notes ?? {};
    const next = normalizeNote(text);
    return next === "" ? rest : { ...rest, [key]: next };
}

export type NoteMenuPlan = { add: boolean; edit: boolean; remove: boolean };

// The same items on every row kind: add when there is no note, edit and remove when there is one.
export function noteMenuPlan(hasNote: boolean): NoteMenuPlan {
    return { add: !hasNote, edit: hasNote, remove: hasNote };
}

export type NoteKeyAction = "save" | "cancel";

// Enter saves and Escape cancels; the Enter that ends an input method's composition is not the developer's.
export function noteKeyAction(e: { key: string; isComposing?: boolean }): NoteKeyAction | null {
    if (e.isComposing) {
        return null;
    }
    if (e.key === "Enter") {
        return "save";
    }
    return e.key === "Escape" ? "cancel" : null;
}

// A row narrower than this shows the note's glyph alone (the text stays in the hover); must match the container query
// in sidebar-agents.css
export const NarrowRowPx = 200;
