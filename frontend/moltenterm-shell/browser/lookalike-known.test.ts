// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { bookmarkAddresses, knownAddresses, pinnedAddresses } from "./lookalike-known";

const pane = (url: string, view = "molten-browser") => ({ view, url });
const config = (...panes: Record<string, any>[]) => ({ tree: { pane: 0 }, panes });

describe("the addresses the window sends to main (#2482)", () => {
    it("lists the bookmarks of every project of the workspace", () => {
        const meta = {
            "molten:bookmarks": {
                p1: {
                    folders: [],
                    items: [{ url: "https://example-shop.com/cart" }, { url: "https://docs.example.org/" }],
                },
                p2: { folders: [], items: [{ url: "https://other.dev/" }, { title: "no address" }, { url: 42 }] },
            },
        };
        expect(bookmarkAddresses(meta)).toEqual([
            "https://example-shop.com/cart",
            "https://docs.example.org/",
            "https://other.dev/",
        ]);
    });

    it("reads nothing from a workspace without bookmarks or with a broken key", () => {
        expect(bookmarkAddresses(null)).toEqual([]);
        expect(bookmarkAddresses({})).toEqual([]);
        expect(bookmarkAddresses({ "molten:bookmarks": "x" })).toEqual([]);
        expect(bookmarkAddresses({ "molten:bookmarks": { p: { items: "x" } } })).toEqual([]);
    });

    it("lists the web pages of the pins of every context and of the workspace's own pinned views", () => {
        const clientMeta = {
            "molten:contextpins:a": [
                { id: "g1", name: "Ledger", rev: 1, config: config(pane("https://ledger-app.io/"), { view: "term" }) },
                { id: "g2", name: "Broken", rev: 1, config: null },
            ],
            "molten:contextpins:b": [
                { id: "g3", name: "Other", rev: 1, config: config(pane("https://other-context.dev/")) },
            ],
        };
        const tabs = [
            { "molten:pinconfig": config(pane("https://pinned.dev/"), pane("not a page", "term")) },
            { "molten:pinconfig": "broken" },
            {},
            null,
        ];
        expect(pinnedAddresses(clientMeta, tabs as any)).toEqual([
            "https://ledger-app.io/",
            "https://other-context.dev/",
            "https://pinned.dev/",
        ]);
    });

    it("sends both lists together", () => {
        expect(
            knownAddresses(
                { "molten:bookmarks": { p: { items: [{ url: "https://a.example/" }] } } },
                {
                    "molten:contextpins:workshop": [
                        { id: "g", name: "n", rev: 1, config: config(pane("https://b.example/")) },
                    ],
                },
                []
            )
        ).toEqual({ bookmarks: ["https://a.example/"], pinned: ["https://b.example/"] });
        expect(knownAddresses(null, null, null)).toEqual({ bookmarks: [], pinned: [] });
    });
});
