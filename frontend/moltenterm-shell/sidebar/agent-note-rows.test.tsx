// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The note on the sidebar's agent rows (FR-SHELL-084, #2008): on the row, right-aligned, left of the activity glyph; a
// field in its place while it is edited; the full text in the expanded agent; the same menu on an agent row, a
// sub-agent row and a linked-agent row.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { Provider } from "jotai";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const menu = vi.hoisted(() => ({ shown: [] as { items: any[]; event: any }[] }));
vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));
vi.mock("@/app/store/wshclientapi", async () => ({ RpcApi: (await import("./agent-note-fake")).fakeWorkspaces.rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/contextmenu", () => ({
    ContextMenuModel: {
        getInstance: () => ({ showContextMenu: (items: any[], event: any) => menu.shown.push({ items, event }) }),
    },
}));

import type { LinkedAgentRow } from "../agent-info/agent-info-hooks";
import type { SubagentRow } from "../agent-info/agent-info-model";
import type { AgentStateInfo } from "../agent-state-model";
import { fakeWorkspaces as fake } from "./agent-note-fake";
import { AgentNotesMetaKey, noteKey } from "./agent-note-model";
import { AgentNotesModel } from "./agent-note-store";
import { agentNoteMenuItems, showAgentNoteMenu, type NoteSubject } from "./agent-note-ui";
import { AgentsSection, LinkedLeaf, SubagentLeaf } from "./sidebar-agents";

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
    fake.bind(WOS);
});

function agent(blockid: string, firstname: string, state = "idle"): AgentStateInfo {
    return {
        blockid,
        tabid: "tab-a",
        workspaceid: "ws1",
        agent: "claude",
        agentname: "Claude Code",
        firstname,
        state,
        version: 1,
    } as AgentStateInfo;
}

function seedBlock(blockId: string, meta: Record<string, unknown>) {
    globalStore.get(WOS.getWaveObjectAtom(WOS.makeORef("block", blockId)));
    WOS.setObjectValue({ otype: "block", oid: blockId, version: 1, meta } as any);
}

function seedNotes(notes: Record<string, string>) {
    fake.seed("ws1", { [AgentNotesMetaKey]: notes });
}

function render(node: React.ReactNode): string {
    return renderToStaticMarkup(<Provider store={globalStore}>{node}</Provider>);
}

function section(agents: AgentStateInfo[]): string {
    return render(<AgentsSection agents={agents} activeTabId="tab-a" />);
}

const Note = "audit sécu nov6, ne pas relancer";

beforeEach(() => {
    fake.reset();
    fake.seed("ws1");
    fake.seed("ws2");
    menu.shown = [];
    AgentNotesModel.resetInstance();
});

afterEach(() => {
    AgentNotesModel.resetInstance();
});

describe("a note on an agent's row", () => {
    it("shows right-aligned after the name and the status, and before the activity glyph of a working agent", () => {
        seedNotes({ b1: Note });
        const html = section([agent("b1", "Arthur", "working")]);
        const text = html.indexOf("mt-sb-agent-tx");
        const note = html.indexOf('data-testid="sidebar-agent-note"');
        const dominoes = html.indexOf("mt-sb-agent-dom");
        expect(text).toBeGreaterThan(-1);
        expect(note).toBeGreaterThan(text);
        expect(dominoes).toBeGreaterThan(note);
        expect(html).toContain(`<span class="mt-sb-note" title="${Note}"`);
        expect(html).toContain(`<span class="mt-sb-note-t">${Note}</span>`);
        expect(html).toContain('class="mt-sb-note-g"');
    });

    it("leaves the name and the status whole, and is not a second line", () => {
        seedNotes({ b1: Note });
        const html = section([agent("b1", "Arthur", "waiting")]);
        expect(html).toContain('class="mt-sb-agent-nm">Arthur</span>');
        expect(html).toMatch(/mt-sb-agent-ss">[^<]+<\/span><\/span><span class="mt-sb-note"/);
    });

    it("keeps the full text in the row, for the hover and for the narrow row that shows only the glyph", () => {
        const long = "x".repeat(80);
        seedNotes({ b1: long });
        const html = section([agent("b1", "Arthur")]);
        expect(html).toContain(`title="${long}"`);
        expect(html).toContain(`mt-sb-note-t">${long}<`);
    });

    it("shows on the agent it belongs to only, and not at all without a note", () => {
        seedNotes({ b2: "attend le gold" });
        const html = section([agent("b1", "Arthur"), agent("b2", "Léa")]);
        expect(html.match(/data-testid="sidebar-agent-note"/g)).toHaveLength(1);
        expect(html).toMatch(/Léa<\/span>[\s\S]*sidebar-agent-note[\s\S]*attend le gold/);
        expect(section([agent("b1", "Arthur")])).not.toContain("sidebar-agent-note");
    });

    it("is text, never markup", () => {
        seedNotes({ b1: "<img src=x onerror=alert(1)>" });
        const html = section([agent("b1", "Arthur")]);
        expect(html).not.toContain("<img");
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });
});

describe("the field in place of the row's text", () => {
    it("opens on the row of the menu's choice, labelled with the agent's name, held at 80 characters", () => {
        seedNotes({ b1: Note });
        AgentNotesModel.getInstance().startEdit("row:b1", "ws1", "b1");
        const html = section([agent("b1", "Arthur", "working"), agent("b2", "Léa")]);
        expect(html.match(/data-testid="sidebar-agent-note-field"/g)).toHaveLength(1);
        expect(html).toContain('maxLength="80"');
        expect(html).toContain('aria-label="Note for Arthur"');
        expect(html).toContain(`value="${Note}"`);
        expect(html).toContain("is-noting");
        const arthur = html.slice(0, html.indexOf('data-block-id="b2"'));
        expect(arthur).not.toContain("mt-sb-agent-tx");
        expect(arthur).not.toContain("mt-sb-agent-dom");
        expect(arthur).not.toContain('sidebar-agent-note"');
        expect(html).toContain('class="mt-sb-agent-nm">Léa</span>');
    });

    it("starts empty for an agent without a note", () => {
        AgentNotesModel.getInstance().startEdit("row:b1", "ws1", "b1");
        expect(section([agent("b1", "Arthur")])).toContain('value=""');
    });
});

describe("the expanded agent", () => {
    it("shows the note in full, a click edits it", () => {
        seedBlock("b1", { "molten:agenttree": { open: true } });
        seedNotes({ b1: Note });
        const html = section([agent("b1", "Arthur")]);
        expect(html).toContain('data-testid="sidebar-agent-note-full"');
        expect(html).toMatch(/sidebar-agent-note-full"[^>]*>[\s\S]*<span>audit sécu nov6, ne pas relancer<\/span>/);
        expect(html.indexOf("sidebar-agent-tree")).toBeLessThan(html.indexOf("sidebar-agent-note-full"));
    });

    it("shows nothing of it while the agent is folded, and nothing without a note", () => {
        seedBlock("b3", { "molten:agenttree": { open: false } });
        seedNotes({ b3: Note });
        expect(section([agent("b3", "Léa")])).not.toContain("sidebar-agent-note-full");
        seedBlock("b4", { "molten:agenttree": { open: true } });
        expect(section([agent("b4", "Lucas")])).not.toContain("sidebar-agent-note-full");
    });

    it("edits in place, at the top of the tree", () => {
        seedBlock("b1", { "molten:agenttree": { open: true } });
        seedNotes({ b1: Note });
        AgentNotesModel.getInstance().startEdit("tree:b1", "ws1", "b1");
        const html = section([agent("b1", "Arthur")]);
        expect(html).toContain('class="mt-sb-note-edit"');
        expect(html).not.toContain("sidebar-agent-note-full");
        expect(html.match(/data-testid="sidebar-agent-note-field"/g)).toHaveLength(1);
    });
});

const sub: SubagentRow = { id: "s1", name: "Explorer le menu", kind: "worker", model: "", state: "working" };

function subLeaf(): string {
    return render(<SubagentLeaf row={sub} cli="claude" onOpen={() => {}} workspaceId="ws1" blockId="b1" />);
}

const linked: LinkedAgentRow = {
    blockId: "b2",
    dir: "out",
    name: "Léa",
    goal: "relecture",
    at: 1,
    count: 1,
    workspaceId: "ws1",
    info: agent("b2", "Léa"),
};

function linkedLeaf(row: LinkedAgentRow = linked): string {
    return render(<LinkedLeaf row={row} workspaceId="ws1" parentId="b1" />);
}

describe("a sub-agent's row", () => {
    it("carries its own note, apart from its parent's", () => {
        seedNotes({ [noteKey("b1", "s1")]: "à relire" });
        expect(subLeaf()).toContain('mt-sb-note-t">à relire<');
        seedNotes({ b1: "la note du parent" });
        expect(subLeaf()).not.toContain("sidebar-agent-note");
    });

    it("gets the field in its place, as a block, not a button holding an input", () => {
        AgentNotesModel.getInstance().startEdit("sub:b1/s1", "ws1", "b1/s1");
        const html = subLeaf();
        expect(html).toContain("mt-sb-leaf is-noting");
        expect(html).toContain('data-testid="sidebar-agent-note-field"');
        expect(html).not.toContain("<button");
    });
});

describe("a linked agent's row", () => {
    it("shows the linked agent's own note: the one its row shows too", () => {
        seedNotes({ b2: "attend le gold" });
        expect(linkedLeaf()).toContain('mt-sb-note-t">attend le gold<');
        expect(section([agent("b2", "Léa")])).toContain('mt-sb-note-t">attend le gold<');
    });

    it("reads the note in the linked agent's workspace", () => {
        fake.seed("ws2", { [AgentNotesMetaKey]: { b2: "dans l'autre espace" } });
        expect(linkedLeaf({ ...linked, workspaceId: "ws2" })).toContain("dans l&#x27;autre espace");
        expect(linkedLeaf()).not.toContain("sidebar-agent-note");
    });

    it("is reachable by the keyboard whether or not the agent can be gone to", () => {
        const html = linkedLeaf({ ...linked, info: undefined });
        expect(html).not.toMatch(/<button[^>]* disabled/);
        expect(html).toContain('aria-disabled="true"');
    });

    it("gets the field in its place", () => {
        AgentNotesModel.getInstance().startEdit("link:b1:out:b2", "ws1", "b2");
        expect(linkedLeaf()).toContain('data-testid="sidebar-agent-note-field"');
    });
});

function subject(kind: NoteSubject["kind"]): NoteSubject {
    const by = {
        agent: { at: "row:b1", key: "b1" },
        sub: { at: "sub:b1/s1", key: "b1/s1" },
        linked: { at: "link:b1:out:b2", key: "b2" },
    }[kind];
    return { kind, workspaceId: "ws1", name: "Arthur", ...by };
}

describe("the context menu, on every kind of row", () => {
    const labels = (items: any[]) => items.map((i) => i.label);

    it.each(["agent", "sub", "linked"] as const)("offers Add a note on a %s row without a note", (kind) => {
        expect(labels(agentNoteMenuItems(subject(kind), false))).toEqual(["Add a note…"]);
    });

    it.each(["agent", "sub", "linked"] as const)("offers Edit and Remove on a %s row with a note", (kind) => {
        expect(labels(agentNoteMenuItems(subject(kind), true))).toEqual(["Edit note", "Remove note"]);
    });

    it.each(["agent", "sub", "linked"] as const)(
        "opens the field of that row from Add and Edit, on a %s row",
        (kind) => {
            const model = AgentNotesModel.getInstance();
            const s = subject(kind);
            agentNoteMenuItems(s, false)[0].click();
            expect(globalStore.get(model.editingAtom)).toEqual({ at: s.at, workspaceId: "ws1", key: s.key });
            model.stopEdit(s.at);
            agentNoteMenuItems(s, true)[0].click();
            expect(globalStore.get(model.isEditingAtom(s.at))).toBe(true);
        }
    );

    it("removes the note from Remove", async () => {
        const model = AgentNotesModel.getInstance();
        model.setNote("ws1", "b1", "audit");
        const remove = agentNoteMenuItems(subject("agent"), true)[1];
        remove.click();
        expect(globalStore.get(model.noteAtom("ws1", "b1"))).toBe("");
        await Promise.resolve();
        expect(fake.calls.at(-1).meta).toEqual({ [AgentNotesMetaKey]: null });
    });

    it("is shown by the app's context menu, with Edit and Remove once the row has a note", () => {
        const event = { type: "contextmenu" } as any;
        showAgentNoteMenu(event, subject("sub"));
        expect(labels(menu.shown[0].items)).toEqual(["Add a note…"]);
        AgentNotesModel.getInstance().setNote("ws1", "b1/s1", "à relire");
        showAgentNoteMenu(event, subject("sub"));
        expect(labels(menu.shown[1].items)).toEqual(["Edit note", "Remove note"]);
        expect(menu.shown[1].event).toBe(event);
    });
});

describe("the rows' wiring", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "sidebar-agents.tsx"), "utf8");

    it("opens the note menu from the contextmenu event of an agent row, a sub-agent row and a linked-agent row", () => {
        expect(source.match(/onContextMenu=\{\(e\) => showAgentNoteMenu\(e, subject\)\}/g)).toHaveLength(3);
        for (const kind of ["agent", "sub", "linked"]) {
            expect(source).toContain(`kind: "${kind}",`);
        }
    });
});
