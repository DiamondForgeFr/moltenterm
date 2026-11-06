// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agents' notes, kept on the workspace (FR-SHELL-084, #2008): add, edit, remove, an empty note removes it, they
// outlive a page and a restart, and a note causes one meta write on its workspace and nothing else.

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));
vi.mock("@/app/store/wshclientapi", async () => ({ RpcApi: (await import("./agent-note-fake")).fakeWorkspaces.rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { fakeWorkspaces as fake } from "./agent-note-fake";
import { AgentNotesMetaKey, noteKey } from "./agent-note-model";
import { AgentNotesModel } from "./agent-note-store";

async function flush() {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
}

// A new page: its own model, which only knows what the workspaces hold.
function newPage(): AgentNotesModel {
    AgentNotesModel.resetInstance();
    return AgentNotesModel.getInstance();
}

function noteOf(model: AgentNotesModel, workspaceId: string, key: string): string {
    return globalStore.get(model.noteAtom(workspaceId, key));
}

beforeAll(() => {
    fake.bind(WOS);
});

beforeEach(() => {
    fake.reset();
    fake.seed("ws1", { name: "kept" });
    fake.seed("ws2");
});

afterEach(() => {
    AgentNotesModel.resetInstance();
});

describe("adding, editing and removing a note", () => {
    it("adds a note, shows it at once, and writes it to the workspace's meta", async () => {
        const model = newPage();
        expect(noteOf(model, "ws1", "b1")).toBe("");
        model.setNote("ws1", "b1", "  audit sécu nov6,\nne pas relancer ");
        expect(noteOf(model, "ws1", "b1")).toBe("audit sécu nov6, ne pas relancer");
        await flush();
        expect(fake.calls).toEqual([
            {
                name: "SetMetaCommand",
                oref: "workspace:ws1",
                meta: { [AgentNotesMetaKey]: { b1: "audit sécu nov6, ne pas relancer" } },
            },
        ]);
        expect(fake.meta("ws1").name).toBe("kept");
    });

    it("edits a note: the new text replaces the old one", async () => {
        const model = newPage();
        model.setNote("ws1", "b1", "attend le gold");
        await flush();
        model.setNote("ws1", "b1", "revoir demain");
        await flush();
        expect(noteOf(model, "ws1", "b1")).toBe("revoir demain");
        expect(fake.meta("ws1")[AgentNotesMetaKey]).toEqual({ b1: "revoir demain" });
    });

    it("removes a note, and the workspace keeps no empty map", async () => {
        const model = newPage();
        model.setNote("ws1", "b1", "attend le gold");
        await flush();
        model.removeNote("ws1", "b1");
        await flush();
        expect(noteOf(model, "ws1", "b1")).toBe("");
        expect(fake.meta("ws1")).toEqual({ name: "kept" });
        expect(fake.calls.at(-1).meta).toEqual({ [AgentNotesMetaKey]: null });
    });

    it("removes a note that is emptied, through the field's Enter", async () => {
        const model = newPage();
        model.setNote("ws1", "b1", "attend le gold");
        await flush();
        model.startEdit("row:b1", "ws1", "b1");
        model.commit("row:b1", "   ");
        await flush();
        expect(noteOf(model, "ws1", "b1")).toBe("");
        expect(fake.meta("ws1")[AgentNotesMetaKey]).toBeUndefined();
        expect(globalStore.get(model.editingAtom)).toBeNull();
    });

    it("writes nothing when the note does not change, or when there is none to remove", async () => {
        const model = newPage();
        model.removeNote("ws1", "b1");
        model.setNote("ws1", "b1", "   ");
        model.setNote("ws1", "b2", "demain");
        await flush();
        const writes = fake.calls.length;
        model.setNote("ws1", "b2", " demain ");
        await flush();
        expect(fake.calls).toHaveLength(writes);
        expect(writes).toBe(1);
    });

    it("holds a note at 80 characters", async () => {
        const model = newPage();
        model.setNote("ws1", "b1", "x".repeat(300));
        await flush();
        expect(noteOf(model, "ws1", "b1")).toHaveLength(80);
        expect((fake.meta("ws1")[AgentNotesMetaKey] as Record<string, string>).b1).toHaveLength(80);
    });

    it("keeps each agent's note, each sub-agent's note and each workspace's notes apart", async () => {
        const model = newPage();
        model.setNote("ws1", "b1", "audit");
        model.setNote("ws1", "b2", "demain");
        model.setNote("ws1", noteKey("b1", "s1"), "relire");
        model.setNote("ws2", "b1", "autre espace");
        await flush();
        expect(noteOf(model, "ws1", "b1")).toBe("audit");
        expect(noteOf(model, "ws1", "b2")).toBe("demain");
        expect(noteOf(model, "ws1", "b1/s1")).toBe("relire");
        expect(noteOf(model, "ws2", "b1")).toBe("autre espace");
        expect(noteOf(model, "ws2", "b2")).toBe("");
        model.removeNote("ws1", "b1");
        await flush();
        expect(noteOf(model, "ws1", "b2")).toBe("demain");
        expect(noteOf(model, "ws1", "b1/s1")).toBe("relire");
        expect(noteOf(model, "ws2", "b1")).toBe("autre espace");
    });
});

describe("the notes outlive the page (#2008)", () => {
    it("are read again from the workspace by a new model, after a reload or a restart", async () => {
        const model = newPage();
        model.setNote("ws1", "b1", "audit sécu nov6, ne pas relancer");
        model.setNote("ws1", noteKey("b1", "s1"), "relire");
        await flush();
        const reloaded = newPage();
        expect(noteOf(reloaded, "ws1", "b1")).toBe("audit sécu nov6, ne pas relancer");
        expect(noteOf(reloaded, "ws1", "b1/s1")).toBe("relire");
        expect(noteOf(reloaded, "ws2", "b1")).toBe("");
    });

    it("shows another window's change live, and its removal", async () => {
        const model = newPage();
        const atom = model.noteAtom("ws1", "b1");
        expect(globalStore.get(atom)).toBe("");
        fake.seed("ws1", { [AgentNotesMetaKey]: { b1: "écrit ailleurs" } });
        expect(globalStore.get(atom)).toBe("écrit ailleurs");
        model.setNote("ws1", "b1", "ici");
        await flush();
        expect(globalStore.get(atom)).toBe("ici");
        fake.seed("ws1", { [AgentNotesMetaKey]: { b1: "plus récent" } });
        expect(globalStore.get(atom)).toBe("plus récent");
        fake.seed("ws1", {});
        expect(globalStore.get(atom)).toBe("");
    });

    it("keeps the note on the page when it cannot be saved", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        fake.fail = true;
        const model = newPage();
        model.setNote("ws1", "b1", "audit");
        await flush();
        expect(noteOf(model, "ws1", "b1")).toBe("audit");
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });
});

describe("a note is the developer's: it reaches nothing but the workspace's meta (#2008)", () => {
    it("causes one meta write on the workspace per change, and no other call", async () => {
        const model = newPage();
        model.startEdit("row:b1", "ws1", "b1");
        model.commit("row:b1", "audit sécu nov6, ne pas relancer");
        model.setNote("ws1", noteKey("b1", "s1"), "relire");
        model.setNote("ws1", "b1", "revoir demain");
        model.removeNote("ws1", "b1");
        await flush();
        expect(fake.calls.length).toBeGreaterThan(0);
        for (const call of fake.calls) {
            expect(call.name).toBe("SetMetaCommand");
            expect(call.oref).toBe("workspace:ws1");
            expect(Object.keys(call.meta)).toEqual([AgentNotesMetaKey]);
        }
    });
});

describe("the field", () => {
    it("opens on one row at a time", () => {
        const model = newPage();
        model.startEdit("row:b1", "ws1", "b1");
        expect(globalStore.get(model.isEditingAtom("row:b1"))).toBe(true);
        expect(globalStore.get(model.isEditingAtom("tree:b1"))).toBe(false);
        model.startEdit("tree:b1", "ws1", "b1");
        expect(globalStore.get(model.isEditingAtom("row:b1"))).toBe(false);
        expect(globalStore.get(model.isEditingAtom("tree:b1"))).toBe(true);
    });

    it("saves on commit and leaves the other rows' fields and a stale commit alone", async () => {
        const model = newPage();
        model.startEdit("row:b1", "ws1", "b1");
        model.commit("tree:b1", "ignoré");
        await flush();
        expect(noteOf(model, "ws1", "b1")).toBe("");
        expect(globalStore.get(model.isEditingAtom("row:b1"))).toBe(true);
        model.commit("row:b1", "gardé");
        expect(noteOf(model, "ws1", "b1")).toBe("gardé");
        expect(globalStore.get(model.isEditingAtom("row:b1"))).toBe(false);
    });

    it("cancels without writing, and gives the focus back to the row only after the keyboard", async () => {
        const model = newPage();
        model.setNote("ws1", "b1", "avant");
        await flush();
        const writes = fake.calls.length;
        model.startEdit("row:b1", "ws1", "b1");
        model.stopEdit("row:b1", true);
        expect(noteOf(model, "ws1", "b1")).toBe("avant");
        expect(fake.calls).toHaveLength(writes);
        expect(model.takeRefocus("tree:b1")).toBe(false);
        expect(model.takeRefocus("row:b1")).toBe(true);
        expect(model.takeRefocus("row:b1")).toBe(false);
        model.startEdit("row:b1", "ws1", "b1");
        model.stopEdit("row:b1", false);
        expect(model.takeRefocus("row:b1")).toBe(false);
    });

    it("does not open without a row, a workspace and a key", () => {
        const model = newPage();
        model.startEdit("", "ws1", "b1");
        model.startEdit("row:b1", "", "b1");
        model.startEdit("row:b1", "ws1", "");
        expect(globalStore.get(model.editingAtom)).toBeNull();
    });
});
