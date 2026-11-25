// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    buildCatalog,
    chainOf,
    childrenOf,
    hereNode,
    matchName,
    nearHere,
    nodeOf,
    noteRecentPlace,
    pathOf,
    readRecentKeys,
    recentNodes,
    searchPlaces,
    type CatalogWorkspace,
} from "./bookmark-places";
import { Here, LevelApp, LevelContext, LevelProject, LevelWorkspace, projectPlaceId, type PlaceRef } from "./bookmarks";

const workspaces: CatalogWorkspace[] = [
    {
        id: "w1",
        name: "Échanges",
        color: "#2fa6a0",
        contextId: "sefers",
        projects: [
            { id: "p1", name: "site-web" },
            { id: "p2", name: "app-mobile" },
        ],
    },
    { id: "w2", name: "Mobile", color: "#6b5bd6", contextId: "sefers", projects: [{ id: "p1", name: "mobile-sdk" }] },
    { id: "w3", name: "Réunions", color: "#e04f5f", contextId: "sefers", projects: [] },
    { id: "w4", name: "Compta", color: "#1f8f5f", contextId: "pro", projects: [{ id: "p1", name: "Clients mobiles" }] },
];

const catalog = buildCatalog({
    appName: "The whole app",
    contexts: [
        { context: { id: "sefers" }, name: "Client: SEFERS" },
        { context: { id: "pro" }, name: "Mes logiciels pro" },
    ],
    workspaces,
});

const ref = (level: PlaceRef["level"], id: string): PlaceRef => ({ level, id });
const Here1: Here = { contextId: "sefers", workspaceId: "w1", projectId: "p1" };

describe("the places of the app", () => {
    it("holds the app, its contexts, their workspaces and their projects, in order", () => {
        expect(catalog.app.name).toBe("The whole app");
        expect(childrenOf(catalog, catalog.app).map((n) => n.name)).toEqual(["Client: SEFERS", "Mes logiciels pro"]);
        const sefers = nodeOf(catalog, ref(LevelContext, "sefers"));
        expect(childrenOf(catalog, sefers).map((n) => n.name)).toEqual(["Échanges", "Mobile", "Réunions"]);
        const echanges = nodeOf(catalog, ref(LevelWorkspace, "w1"));
        expect(childrenOf(catalog, echanges).map((n) => n.name)).toEqual(["site-web", "app-mobile"]);
        expect(echanges.color).toBe("#2fa6a0");
    });

    it("tells apart the same project id of two workspaces", () => {
        const first = nodeOf(catalog, ref(LevelProject, projectPlaceId("w1", "p1")));
        const second = nodeOf(catalog, ref(LevelProject, projectPlaceId("w2", "p1")));
        expect(first.name).toBe("site-web");
        expect(second.name).toBe("mobile-sdk");
    });

    it("names the places above a place, from the app down", () => {
        expect(pathOf(catalog, ref(LevelProject, projectPlaceId("w1", "p2")))).toEqual([
            "The whole app",
            "Client: SEFERS",
            "Échanges",
        ]);
        expect(chainOf(catalog, ref(LevelApp, "")).map((n) => n.name)).toEqual(["The whole app"]);
        expect(chainOf(catalog, ref(LevelWorkspace, "gone"))).toEqual([]);
    });

    it("finds the deepest place of here that it knows", () => {
        expect(hereNode(catalog, Here1).ref).toEqual(ref(LevelProject, projectPlaceId("w1", "p1")));
        expect(hereNode(catalog, { ...Here1, projectId: null }).ref).toEqual(ref(LevelWorkspace, "w1"));
        expect(hereNode(catalog, { contextId: "x", workspaceId: "y", projectId: null })).toBe(catalog.app);
    });
});

describe("the place finder's search (mockup 2 ter)", () => {
    it("finds contexts, workspaces and projects across every context, the matched letters first", () => {
        const found = searchPlaces(catalog, "mob");
        const names = found.map((m) => m.node.name);
        expect(names).toContain("Mobile");
        expect(names).toContain("app-mobile");
        expect(names).toContain("mobile-sdk");
        expect(names).toContain("Clients mobiles");
        expect(names[0]).toBe("Mobile");
        const mobile = found.find((m) => m.node.name === "Mobile");
        expect(mobile.positions).toEqual([0, 1, 2]);
        const app = found.find((m) => m.node.name === "app-mobile");
        expect(app.positions).toEqual([4, 5, 6]);
    });

    it("never offers the app, which the places of here already do", () => {
        expect(searchPlaces(catalog, "whole").map((m) => m.node.ref.level)).not.toContain(LevelApp);
    });

    it("ignores case and accents, and matches the letters in order when they are apart", () => {
        const names = searchPlaces(catalog, "ECHANGES").map((m) => m.node.name);
        expect(names[0]).toBe("Échanges");
        expect(names.slice(1).sort()).toEqual(["app-mobile", "site-web"]);
        const apart = searchPlaces(catalog, "smb");
        expect(apart.map((m) => m.node.name)).toContain("mobile-sdk");
        expect(searchPlaces(catalog, "zzz")).toEqual([]);
    });

    it("finds a place by its path when its own name does not match, with nothing underlined", () => {
        const found = searchPlaces(catalog, "sefers");
        const byPath = found.find((m) => m.node.name === "site-web");
        expect(byPath).toBeDefined();
        expect(byPath.positions).toEqual([]);
        expect(found[0].node.name).toBe("Client: SEFERS");
    });

    it("scores a run at the start of a word above one inside it", () => {
        expect(matchName("mobile-sdk", "mob").score).toBeGreaterThan(matchName("app-mobile", "mob").score);
        expect(matchName("app-mobile", "mob").score).toBeGreaterThan(matchName("zmobile", "mob").score);
        expect(matchName("abc", "")).toEqual({ positions: [], score: 0 });
        expect(matchName("abc", "xyz")).toBeNull();
    });

    it("keeps the positions in code points, so an accent or an emoji does not shift them", () => {
        const match = matchName("📘 Échanges", "ech");
        expect(match.positions).toEqual([2, 3, 4]);
        expect(Array.from("📘 Échanges")[2]).toBe("É");
    });
});

describe("what the finder lists before anything is typed", () => {
    it("offers the other projects of the workspace, then the context's other workspaces and their projects", () => {
        const near = nearHere(catalog, Here1).map((n) => n.name);
        expect(near).toEqual(["app-mobile", "Mobile", "mobile-sdk", "Réunions"]);
        expect(near).not.toContain("Échanges");
        expect(near).not.toContain("site-web");
        expect(near).not.toContain("Compta");
    });

    it("lists no more than the limit", () => {
        expect(nearHere(catalog, Here1, 2)).toHaveLength(2);
    });

    it("keeps the recent places, newest first, without the app and without a place that is gone", () => {
        const memory = new Map<string, string>();
        const storage = {
            getItem: (k: string) => memory.get(k) ?? null,
            setItem: (k: string, v: string) => void memory.set(k, v),
        };
        const before = globalThis.localStorage;
        Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
        try {
            noteRecentPlace(ref(LevelWorkspace, "w2"));
            noteRecentPlace(ref(LevelProject, projectPlaceId("w1", "p2")));
            noteRecentPlace(ref(LevelWorkspace, "w2"));
            noteRecentPlace(ref(LevelWorkspace, "gone"));
            noteRecentPlace(ref(LevelApp, ""));
            const keys = readRecentKeys();
            expect(keys.slice(0, 3)).toEqual(["app", "workspace:gone", "workspace:w2"]);
            expect(recentNodes(catalog, keys).map((n) => n.name)).toEqual(["Mobile", "app-mobile"]);
        } finally {
            Object.defineProperty(globalThis, "localStorage", { value: before, configurable: true });
        }
    });

    it("reads no recent places when the browser storage is missing or broken", () => {
        const before = globalThis.localStorage;
        Object.defineProperty(globalThis, "localStorage", {
            value: {
                getItem: () => {
                    throw new Error("blocked");
                },
                setItem: () => {
                    throw new Error("blocked");
                },
            },
            configurable: true,
        });
        try {
            expect(readRecentKeys()).toEqual([]);
            expect(() => noteRecentPlace(ref(LevelWorkspace, "w1"))).not.toThrow();
        } finally {
            Object.defineProperty(globalThis, "localStorage", { value: before, configurable: true });
        }
    });
});
