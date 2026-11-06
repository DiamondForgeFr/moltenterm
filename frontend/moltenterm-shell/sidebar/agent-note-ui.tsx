// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The note on an agent's row (FR-SHELL-084, #2008): a small secondary tag on the right of the row, just left of the
// activity glyph, that shrinks before the name and the status do; one line edited in place, in the row's own place; the
// full text at the top of the expanded agent. The row's context menu (Shift+F10 or the context-menu key opens it too:
// the menu host sends the focused row a contextmenu event) adds, edits and removes it.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { t, useT } from "../i18n/i18n";
import { MaxNoteLength, noteKeyAction, noteMenuPlan, type NoteRowKind } from "./agent-note-model";
import { AgentNotesModel } from "./agent-note-store";

// What a row's note is about: the row kind, the row itself (a note shows on several rows, one field opens), the
// workspace and key the note is kept under, and the name the field is labelled with.
export type NoteSubject = {
    kind: NoteRowKind;
    at: string;
    workspaceId: string;
    key: string;
    name: string;
};

export function useAgentNote(workspaceId: string, key: string): string {
    return useAtomValue(AgentNotesModel.getInstance().noteAtom(workspaceId, key));
}

export function useNoteEditing(at: string): boolean {
    return useAtomValue(AgentNotesModel.getInstance().isEditingAtom(at));
}

// A field closed with the keyboard gives the focus back to the row it was on, so the keyboard goes on from there.
export function useNoteRefocus(at: string, editing: boolean, ref: React.RefObject<HTMLElement>) {
    useEffect(() => {
        if (!editing && AgentNotesModel.getInstance().takeRefocus(at)) {
            ref.current?.focus();
        }
    }, [editing]);
}

export function NoteGlyph() {
    return (
        <svg
            className="mt-sb-note-g"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M5 4h14v10l-5 6H5z M14 20v-6h5" />
        </svg>
    );
}

// The tag on a row. The text is in the DOM even when the row is too narrow to show it, for the hover and for screen
// readers.
export function AgentNoteTag({ text }: { text: string }) {
    return (
        <span className="mt-sb-note" title={text} data-testid="sidebar-agent-note">
            <NoteGlyph />
            <span className="mt-sb-note-t">{text}</span>
        </span>
    );
}

// One line, at most MaxNoteLength characters. Enter saves and Escape cancels; leaving the field saves, as renaming a
// view does. An empty note removes it.
export function AgentNoteField({ at, name, initial }: { at: string; name: string; initial: string }) {
    const t = useT();
    const label = t("sidebar.agents.note.field", { name });
    const ref = useRef<HTMLInputElement>(null);
    const done = useRef(false);
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);
    const finish = (save: boolean, keyboard: boolean) => {
        if (done.current) {
            return;
        }
        done.current = true;
        const model = AgentNotesModel.getInstance();
        if (save) {
            model.commit(at, ref.current?.value ?? initial, keyboard);
            return;
        }
        model.stopEdit(at, keyboard);
    };
    return (
        <input
            ref={ref}
            type="text"
            className="mt-sb-note-in"
            defaultValue={initial}
            maxLength={MaxNoteLength}
            placeholder={label}
            aria-label={label}
            data-testid="sidebar-agent-note-field"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
                e.stopPropagation();
                const action = noteKeyAction({ key: e.key, isComposing: e.nativeEvent?.isComposing });
                if (action == null) {
                    return;
                }
                e.preventDefault();
                finish(action === "save", true);
            }}
            onBlur={() => finish(true, false)}
        />
    );
}

// The expanded agent's note: whole, wrapped, a click edits it.
export function AgentNoteFull({ subject }: { subject: NoteSubject }) {
    const t = useT();
    const text = useAgentNote(subject.workspaceId, subject.key);
    const editing = useNoteEditing(subject.at);
    if (editing) {
        return (
            <div className="mt-sb-note-edit">
                <AgentNoteField at={subject.at} name={subject.name} initial={text} />
            </div>
        );
    }
    if (text === "") {
        return null;
    }
    return (
        <button
            type="button"
            className="mt-sb-note-full"
            title={t("sidebar.agents.note.edit")}
            data-testid="sidebar-agent-note-full"
            onClick={() => AgentNotesModel.getInstance().startEdit(subject.at, subject.workspaceId, subject.key)}
        >
            <NoteGlyph />
            <span>{text}</span>
        </button>
    );
}

// The same items on an agent row, a sub-agent row and a linked-agent row: add without a note, edit and remove with
// one. Resolved when the menu opens, so a change of language shows.
export function agentNoteMenuItems(subject: NoteSubject, hasNote: boolean): ContextMenuItem[] {
    const model = AgentNotesModel.getInstance();
    const plan = noteMenuPlan(hasNote);
    const edit = () => model.startEdit(subject.at, subject.workspaceId, subject.key);
    const items: ContextMenuItem[] = [];
    if (plan.add) {
        items.push({ label: t("sidebar.agents.note.add"), icon: "note-sticky", click: edit });
    }
    if (plan.edit) {
        items.push({ label: t("sidebar.agents.note.edit"), icon: "pen", click: edit });
    }
    if (plan.remove) {
        items.push({
            label: t("sidebar.agents.note.remove"),
            icon: "xmark",
            click: () => model.removeNote(subject.workspaceId, subject.key),
        });
    }
    return items;
}

export function showAgentNoteMenu(e: React.MouseEvent, subject: NoteSubject) {
    const model = AgentNotesModel.getInstance();
    const hasNote = globalStore.get(model.noteAtom(subject.workspaceId, subject.key)) !== "";
    ContextMenuModel.getInstance().showContextMenu(agentNoteMenuItems(subject, hasNote), e);
}
