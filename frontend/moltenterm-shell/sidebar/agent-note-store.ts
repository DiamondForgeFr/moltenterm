// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agents' notes (FR-SHELL-084, #2008): read from the workspace's meta, written back there with one meta write. A
// write is the only thing a note ever causes: nothing reaches the agent's terminal, its session or a handoff. A page
// shows its own write at once, until the workspace's meta changes from what it was then (another window's newer
// write, or this write coming back from wavesrv).

import { globalStore } from "@/app/store/jotaiStore";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { AgentNotes, AgentNotesMetaKey, readNotes, withNote } from "./agent-note-model";

type Pending = { value: AgentNotes; base: string };

// The note being edited and the row it is edited on: a note can show on several rows (the agent's, a linked row, the
// expanded tree), and one field opens, on the row the developer chose.
export type NoteEditing = { at: string; workspaceId: string; key: string };

function stamp(v: unknown): string {
    return JSON.stringify(v ?? null);
}

function workspaceAtom(workspaceId: string): Atom<Workspace> {
    return getWaveObjectAtom<Workspace>(makeORef("workspace", workspaceId));
}

function savedNotes(workspaceId: string): unknown {
    return globalStore.get(workspaceAtom(workspaceId))?.meta?.[AgentNotesMetaKey];
}

export class AgentNotesModel {
    private static instance: AgentNotesModel = null;

    editingAtom = atom(null) as PrimitiveAtom<NoteEditing>;
    pendingAtom = atom({}) as PrimitiveAtom<Record<string, Pending>>;
    notesAtoms = new Map<string, Atom<AgentNotes>>();
    noteAtoms = new Map<string, Atom<string>>();
    editingHereAtoms = new Map<string, Atom<boolean>>();
    // The row to give the focus back to once its field closes with the keyboard.
    refocus: string = null;

    private constructor() {}

    static getInstance(): AgentNotesModel {
        if (!AgentNotesModel.instance) {
            AgentNotesModel.instance = new AgentNotesModel();
        }
        return AgentNotesModel.instance;
    }

    static resetInstance(): void {
        AgentNotesModel.instance = null;
    }

    notesAtom(workspaceId: string): Atom<AgentNotes> {
        let rtn = this.notesAtoms.get(workspaceId);
        if (rtn == null) {
            const workspace = workspaceAtom(workspaceId);
            rtn = atom((get) => {
                const meta = get(workspace)?.meta?.[AgentNotesMetaKey];
                const pending = get(this.pendingAtom)[workspaceId];
                if (pending != null && pending.base === stamp(meta)) {
                    return pending.value;
                }
                return readNotes(meta);
            });
            this.notesAtoms.set(workspaceId, rtn);
        }
        return rtn;
    }

    // "" when the agent has no note; a string, so a row re-renders only when its own note changes.
    noteAtom(workspaceId: string, key: string): Atom<string> {
        const name = `${workspaceId}\n${key}`;
        let rtn = this.noteAtoms.get(name);
        if (rtn == null) {
            const notes = this.notesAtom(workspaceId);
            rtn = atom((get) => get(notes)[key] ?? "");
            this.noteAtoms.set(name, rtn);
        }
        return rtn;
    }

    isEditingAtom(at: string): Atom<boolean> {
        let rtn = this.editingHereAtoms.get(at);
        if (rtn == null) {
            rtn = atom((get) => get(this.editingAtom)?.at === at);
            this.editingHereAtoms.set(at, rtn);
        }
        return rtn;
    }

    startEdit(at: string, workspaceId: string, key: string): void {
        if (!at || !workspaceId || !key) {
            return;
        }
        globalStore.set(this.editingAtom, { at, workspaceId, key });
    }

    // Closes the field of row `at`; keyboard: the row takes the focus back, which the field's close lost.
    stopEdit(at: string, keyboard = false): void {
        if (globalStore.get(this.editingAtom)?.at !== at) {
            return;
        }
        globalStore.set(this.editingAtom, null);
        this.refocus = keyboard ? at : null;
    }

    takeRefocus(at: string): boolean {
        if (this.refocus !== at) {
            return false;
        }
        this.refocus = null;
        return true;
    }

    // The developer's field is done: the text is the note (empty removes it), the field closes.
    commit(at: string, text: string, keyboard = true): void {
        const editing = globalStore.get(this.editingAtom);
        if (editing?.at !== at) {
            return;
        }
        this.stopEdit(at, keyboard);
        this.setNote(editing.workspaceId, editing.key, text);
    }

    setNote(workspaceId: string, key: string, text: string): void {
        if (!workspaceId || !key) {
            return;
        }
        const current = globalStore.get(this.notesAtom(workspaceId));
        const next = withNote(current, key, text);
        if (stamp(next) === stamp(current)) {
            return;
        }
        globalStore.set(this.pendingAtom, {
            ...globalStore.get(this.pendingAtom),
            [workspaceId]: { value: next, base: stamp(savedNotes(workspaceId)) },
        });
        this.save(workspaceId, next);
    }

    removeNote(workspaceId: string, key: string): void {
        this.setNote(workspaceId, key, "");
    }

    // An async function: a write that throws (no backend) fails as a promise, whose failure is only logged; the page
    // keeps the note it shows.
    save(workspaceId: string, notes: AgentNotes): void {
        const meta = { [AgentNotesMetaKey]: Object.keys(notes).length > 0 ? notes : null };
        const write = async () => {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("workspace", workspaceId),
                meta: meta as MetaType,
            });
        };
        write().catch((e) => console.log("agent notes: could not save on the workspace", e));
    }
}
