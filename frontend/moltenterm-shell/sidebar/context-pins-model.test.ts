// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The top row of the sidebar belongs to the context (FR-SHELL-080, FR-SHELL-159, #2526): one row per context in the
// client's meta, read through the context of the workspace a window shows.

import { describe, expect, it } from "vitest";
import { ContextsMetaKey, WorkspaceContextMetaKey } from "../contexts/context-model";
import {
    contextPinsKey,
    hasContextPins,
    readAllContextPins,
    readContextPins,
    startingPinsPatch,
    windowContextIdOf,
    windowContextPins,
} from "./context-pins-model";
import { GlobalPin } from "./view-pins-model";

function pin(id: string, name = id): GlobalPin {
    return { id, name, rev: 1, config: { tree: { pane: 0 }, panes: [{ view: "term" }] } };
}

const contexts = [{ id: "client", name: "Client: SEFERS" }, { id: "personal", name: "Mes logiciels pro" }];

function client(rows: Record<string, GlobalPin[]>): Record<string, any> {
    const meta: Record<string, any> = { [ContextsMetaKey]: contexts };
    for (const [id, pins] of Object.entries(rows)) {
        meta[contextPinsKey(id)] = pins;
    }
    return meta;
}

const inClient = { [WorkspaceContextMetaKey]: "client" };
const inPersonal = { [WorkspaceContextMetaKey]: "personal" };

describe("pins are stored per context (#2526)", () => {
    it("keeps each context's row under its own key", () => {
        expect(contextPinsKey("client")).not.toBe(contextPinsKey("personal"));
        const meta = client({ client: [pin("g1")], personal: [] });
        expect(readContextPins(meta, "client").map((p) => p.id)).toEqual(["g1"]);
        expect(readContextPins(meta, "personal")).toEqual([]);
        expect(readContextPins(meta, "other")).toEqual([]);
    });

    it("tells a context with an emptied row from one that holds none", () => {
        const meta = client({ personal: [] });
        expect(hasContextPins(meta, "personal")).toBe(true);
        expect(hasContextPins(meta, "client")).toBe(false);
        expect(hasContextPins(null, "client")).toBe(false);
    });

    it("reads only the valid pins of a row", () => {
        const meta = { [contextPinsKey("client")]: [pin("g1"), { id: "", config: null }, null, "x"] };
        expect(readContextPins(meta, "client").map((p) => p.id)).toEqual(["g1"]);
    });
});

describe("two contexts show different tiles (#2526)", () => {
    const meta = client({ client: [pin("g1", "Terminal"), pin("g2", "Lanceur")], personal: [pin("g3", "google.com")] });

    it("shows a workspace the row of its context", () => {
        expect(windowContextPins(meta, inClient).map((p) => p.name)).toEqual(["Terminal", "Lanceur"]);
        expect(windowContextPins(meta, inPersonal).map((p) => p.name)).toEqual(["google.com"]);
    });

    it("shows every workspace of a context the same row", () => {
        const second = { [WorkspaceContextMetaKey]: "client", "molten:project": "/another/project" };
        expect(windowContextPins(meta, second)).toEqual(windowContextPins(meta, inClient));
    });

    it("puts a workspace that names no context, or a gone one, in the first context", () => {
        expect(windowContextIdOf(meta, {})).toBe("client");
        expect(windowContextIdOf(meta, { [WorkspaceContextMetaKey]: "deleted" })).toBe("client");
        expect(windowContextPins(meta, {}).map((p) => p.name)).toEqual(["Terminal", "Lanceur"]);
    });

    it("swaps the row when the workspace shown changes context", () => {
        const before = windowContextPins(meta, inClient).map((p) => p.id);
        const after = windowContextPins(meta, inPersonal).map((p) => p.id);
        expect(before).toEqual(["g1", "g2"]);
        expect(after).toEqual(["g3"]);
    });

    it("lists every context's pins for what looks at all the pinned views", () => {
        expect(readAllContextPins(meta).map((p) => p.id)).toEqual(["g1", "g2", "g3"]);
        expect(readAllContextPins(null)).toEqual([]);
    });
});

describe("a new context gets its starting tiles (#2526)", () => {
    const meta = client({ client: [pin("g1", "Terminal"), pin("g2", "Lanceur")], personal: [pin("g3")] });

    it("starts with a copy of the row of the context it was made from", () => {
        const patch = startingPinsPatch(meta, "new", "client");
        expect(Object.keys(patch)).toEqual([contextPinsKey("new")]);
        expect((patch[contextPinsKey("new")] as GlobalPin[]).map((p) => p.name)).toEqual(["Terminal", "Lanceur"]);
    });

    it("starts with the row of the context it was made from, whichever that is", () => {
        const patch = startingPinsPatch(meta, "new", "personal");
        expect((patch[contextPinsKey("new")] as GlobalPin[]).map((p) => p.id)).toEqual(["g3"]);
    });

    it("starts empty when the context it came from has no tile, or is unknown", () => {
        expect(startingPinsPatch(meta, "new", "unknown")[contextPinsKey("new")]).toEqual([]);
        expect(startingPinsPatch(client({ client: [] }), "new", "client")[contextPinsKey("new")]).toEqual([]);
    });

    it("never overwrites the row a context already holds, so a start is written once", () => {
        expect(startingPinsPatch(meta, "personal", "client")).toBeNull();
        expect(startingPinsPatch(client({ client: [pin("g1")], other: [] }), "other", "client")).toBeNull();
        expect(startingPinsPatch(meta, "", "client")).toBeNull();
    });

    it("then evolves on its own: the copy and its source are two rows", () => {
        const patch = startingPinsPatch(meta, "new", "client");
        const after = { ...meta, ...patch, [contextPinsKey("client")]: [pin("g1", "Terminal")] };
        expect(readContextPins(after, "new").map((p) => p.id)).toEqual(["g1", "g2"]);
        expect(readContextPins(after, "client").map((p) => p.id)).toEqual(["g1"]);
    });
});
