// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    contextFolderOf,
    contextHint,
    contextIdOf,
    ContextInfo,
    contextShownEmblem,
    contextShownName,
    ContextWorkspace,
    DefaultContextEmblem,
    DefaultContextId,
    entriesOfContext,
    freeWorkspaceOfContext,
    landingWorkspace,
    makeChecklist,
    makeRibbons,
    readContexts,
    shapeSubjects,
    waitingElsewhere,
    windowTitleWithContext,
    WorkspaceContextMetaKey,
} from "./context-model";

const t = (key: string) => (key === "contexts.defaultName" ? "My workshop" : key);

function ws(id: string, contextId: string, extra: Partial<ContextWorkspace> = {}): ContextWorkspace {
    return {
        id,
        contextId,
        name: id.toUpperCase(),
        color: "#58C142",
        saved: true,
        active: false,
        open: false,
        ...extra,
    };
}

describe("reading the contexts", () => {
    it("holds the default context alone when nothing is stored", () => {
        for (const meta of [undefined, null, {}, { "molten:contexts": "x" }, { "molten:contexts": [] }]) {
            const list = readContexts(meta as any);
            expect(list).toHaveLength(1);
            expect(list[0]).toMatchObject({ id: DefaultContextId, emblem: DefaultContextEmblem });
        }
    });

    it("keeps the stored order and drops an entry with no id or a repeated one", () => {
        const list = readContexts({
            "molten:contexts": [
                { id: "a", name: "A", description: "d", emblem: "book", last: "w1", folder: "/c" },
                { name: "no id" },
                { id: "a", name: "again" },
                { id: "b", name: 4 },
            ],
        });
        expect(list.map((c) => c.id)).toEqual(["a", "b"]);
        expect(list[0]).toEqual({
            id: "a",
            name: "A",
            description: "d",
            emblem: "book",
            shape: "",
            last: "w1",
            folder: "/c",
        });
        expect(list[1].name).toBe("");
        expect(list[1].folder).toBe("");
    });

    // #2516: a context's folder bounds its workspaces; a workspace names its context in its own meta.
    it("reads the folder of the context a workspace is in", () => {
        const list = readContexts({ "molten:contexts": [{ id: "a" }, { id: "b", folder: "/clients/sefers" }] });
        expect(contextFolderOf(list, { "molten:context": "b" })).toBe("/clients/sefers");
        expect(contextFolderOf(list, {})).toBe("");
        expect(contextFolderOf(list, { "molten:context": "gone" })).toBe("");
    });

    it("reads the shape a context stores, and none for a shape that is not one of the fifteen", () => {
        const list = readContexts({
            "molten:contexts": [
                { id: "a", shape: "moon" },
                { id: "b", shape: "triangle" },
                { id: "c", shape: 4 },
                { id: "d" },
            ],
        });
        expect(list.map((c) => c.shape)).toEqual(["moon", "", "", ""]);
    });

    it("puts a workspace with no context, or an unknown one, in the first context", () => {
        const list: ContextInfo[] = [{ id: "first" }, { id: "second" }];
        expect(contextIdOf(list, undefined)).toBe("first");
        expect(contextIdOf(list, {})).toBe("first");
        expect(contextIdOf(list, { [WorkspaceContextMetaKey]: "gone" })).toBe("first");
        expect(contextIdOf(list, { [WorkspaceContextMetaKey]: 3 })).toBe("first");
        expect(contextIdOf(list, { [WorkspaceContextMetaKey]: "second" })).toBe("second");
    });
});

describe("the names and emblems on screen", () => {
    it("shows the default context in the interface language until it is renamed", () => {
        expect(contextShownName({ id: DefaultContextId }, t)).toBe("My workshop");
        expect(contextShownName({ id: DefaultContextId, name: "Studio" }, t)).toBe("Studio");
        expect(contextShownName({ id: "x", name: "DiamondForge" }, t)).toBe("DiamondForge");
        expect(contextShownName({ id: "x" }, t)).toBe("");
    });

    it("gives a context without an emblem the default or the fallback one", () => {
        expect(contextShownEmblem({ id: DefaultContextId })).toBe(DefaultContextEmblem);
        expect(contextShownEmblem({ id: "x" })).toBe("folder");
        expect(contextShownEmblem({ id: "x", emblem: "briefcase" })).toBe("briefcase");
    });
});

describe("the switcher's entries", () => {
    const entries = [
        { id: "a", contextId: "one", active: false },
        { id: "b", contextId: "two", active: false },
        { id: "c", contextId: "one", active: false },
        { id: "tmp", contextId: "", active: true },
    ];

    it("lists the window's context and always the workspace on screen", () => {
        expect(entriesOfContext(entries, "one").map((e) => e.id)).toEqual(["a", "c", "tmp"]);
        expect(entriesOfContext(entries, "two").map((e) => e.id)).toEqual(["b", "tmp"]);
    });

    it("lists everything when no context is known yet", () => {
        expect(entriesOfContext(entries, "").map((e) => e.id)).toEqual(["a", "b", "c", "tmp"]);
    });
});

describe("where choosing a context lands", () => {
    it("lands on the workspace the context last showed", () => {
        const list = [ws("a", "one"), ws("b", "one"), ws("c", "two")];
        expect(landingWorkspace("one", list, "b").id).toBe("b");
    });

    it("lands on the first workspace without a last one", () => {
        const list = [ws("a", "one"), ws("b", "one")];
        expect(landingWorkspace("one", list, "").id).toBe("a");
        expect(landingWorkspace("one", list, "gone").id).toBe("a");
    });

    it("prefers a workspace no other window shows, and the window's own counts as free", () => {
        const list = [ws("a", "one", { open: true }), ws("b", "one"), ws("c", "one", { open: true, active: true })];
        expect(landingWorkspace("one", list, "a").id).toBe("b");
        expect(landingWorkspace("one", [list[0], list[2]], "a").id).toBe("c");
    });

    it("falls back to the one that is shown elsewhere when every one is", () => {
        const list = [ws("a", "one", { open: true }), ws("b", "one", { open: true })];
        expect(landingWorkspace("one", list, "b").id).toBe("b");
        expect(landingWorkspace("one", list, "").id).toBe("a");
    });

    it("lands on nothing when the context holds no saved workspace", () => {
        expect(landingWorkspace("empty", [ws("a", "one"), ws("u", "empty", { saved: false })], "")).toBeNull();
    });
});

describe("opening a context in a new window", () => {
    it("opens a workspace no window shows, the last one first", () => {
        const list = [ws("a", "one", { open: true }), ws("b", "one"), ws("c", "one")];
        expect(freeWorkspaceOfContext("one", list, "c").id).toBe("c");
        expect(freeWorkspaceOfContext("one", list, "").id).toBe("b");
    });

    it("finds none when every workspace of the context is shown", () => {
        expect(freeWorkspaceOfContext("one", [ws("a", "one", { open: true })], "")).toBeNull();
        expect(freeWorkspaceOfContext("one", [], "")).toBeNull();
    });

    it("never offers an unsaved workspace", () => {
        expect(freeWorkspaceOfContext("one", [ws("u", "one", { saved: false })], "")).toBeNull();
    });
});

describe("the ribbons of the menu", () => {
    const contexts: ContextInfo[] = [{ id: DefaultContextId }, { id: "df", name: "DiamondForge", emblem: "briefcase" }];
    const entries = [
        ws("a", DefaultContextId, { color: "#111111", active: true, open: true }),
        ws("b", "df", { color: "#222222" }),
        ws("c", "df", { color: "#333333" }),
    ];

    it("makes one ribbon per context with the colour of the workspace it lands on", () => {
        const ribbons = makeRibbons(contexts, entries, DefaultContextId, () => 0, t);
        expect(ribbons.map((r) => [r.name, r.emblem, r.here, r.landing?.color])).toEqual([
            ["My workshop", "hammer", true, "#111111"],
            ["DiamondForge", "briefcase", false, "#222222"],
        ]);
    });

    it("hints where the window is, what waits and how many workspaces", () => {
        expect(contextHint(true, 3, 4)).toEqual({ kind: "here" });
        expect(contextHint(false, 2, 4)).toEqual({ kind: "waiting", count: 2 });
        expect(contextHint(false, 0, 4)).toEqual({ kind: "workspaces", count: 4 });
        const ribbons = makeRibbons(contexts, entries, DefaultContextId, (id) => (id === "c" ? 1 : 0), t);
        expect(ribbons[1].hint).toEqual({ kind: "waiting", count: 1 });
        expect(ribbons[1].workspaces).toBe(2);
    });

    it("counts the agents that wait elsewhere for the dot, never the ones of the window's own context", () => {
        const ribbons = makeRibbons(contexts, entries, DefaultContextId, () => 1, t);
        expect(waitingElsewhere(ribbons)).toBe(2);
        expect(ribbons[0].waiting).toBe(0);
    });

    it("draws each context with its own shape, the V point until the migration reaches it", () => {
        const withShapes: ContextInfo[] = [{ id: DefaultContextId }, { id: "df", shape: "moon" }, { id: "x" }];
        const ribbons = makeRibbons(withShapes, entries, DefaultContextId, () => 0, t);
        expect(ribbons.map((r) => r.shape)).toEqual(["v", "moon", "v"]);
    });

    it("counts the agents of each context that work, the window's own context included", () => {
        const working = (id: string) => ({ a: 1, b: 2, c: 1 })[id] ?? 0;
        const ribbons = makeRibbons(contexts, entries, DefaultContextId, () => 0, t, working);
        expect(ribbons.map((r) => [r.here, r.working])).toEqual([
            [true, 1],
            [false, 3],
        ]);
        expect(makeRibbons(contexts, entries, DefaultContextId, () => 0, t).map((r) => r.working)).toEqual([0, 0]);
    });

    it("gives the shape draw each context with the colour of its ribbon", () => {
        const subjects = shapeSubjects(contexts, entries);
        expect(subjects.map((s) => [s.context.id, s.colour])).toEqual([
            [DefaultContextId, "#111111"],
            ["df", "#222222"],
        ]);
        expect(shapeSubjects([...contexts, { id: "empty" }], entries)[2].colour).toBe("");
    });

    it("has no landing for a context with no workspace", () => {
        const ribbons = makeRibbons(
            [...contexts, { id: "empty", name: "Empty" }],
            entries,
            DefaultContextId,
            () => 0,
            t
        );
        expect(ribbons[2].landing).toBeNull();
        expect(ribbons[2].hint).toEqual({ kind: "workspaces", count: 0 });
    });
});

describe("the window title", () => {
    it("names the application, the context, then the tab", () => {
        expect(windowTitleWithContext("MoltenTerm", "DiamondForge", "Project")).toBe(
            "MoltenTerm — DiamondForge - Project"
        );
        expect(windowTitleWithContext("MoltenTerm", "", "Project")).toBe("MoltenTerm - Project");
        expect(windowTitleWithContext("MoltenTerm", "DiamondForge", "")).toBe("MoltenTerm — DiamondForge");
    });
});

describe("the checklist of Manage contexts", () => {
    const contexts: ContextInfo[] = [{ id: DefaultContextId }, { id: "df", name: "DiamondForge" }];
    const entries = [ws("a", DefaultContextId), ws("b", "df"), ws("u", "df", { saved: false })];

    it("checks the context's workspaces and says where the others are", () => {
        const rows = makeChecklist("df", contexts, entries, t);
        expect(rows.map((r) => [r.id, r.checked, r.elsewhere])).toEqual([
            ["a", false, "My workshop"],
            ["b", true, ""],
        ]);
    });
});
