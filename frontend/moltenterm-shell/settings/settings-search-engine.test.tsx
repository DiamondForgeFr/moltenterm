// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Settings › Browser › Search engine (#2312, FR-SHELL-035): the presets, the recommendation, the engine in use, and no
// network call to show the list.

import { createStore, Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { getSettingsKeyAtom: (key: string) => atom(() => state.settings[key]) };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetConfigCommand: async () => {} } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { SearchEnginePresets } from "../browser/search-engine-model";
import { SearchEnginePicker } from "./settings-search-engine";

function rows(): { id: string; selected: boolean; text: string }[] {
    const html = renderToStaticMarkup(
        <Provider store={createStore()}>
            <SearchEnginePicker />
        </Provider>
    );
    return [...html.matchAll(/<label[^>]*data-option="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g)].map((m) => ({
        id: m[1],
        selected: /<input[^>]*checked=""/.test(m[2]),
        text: m[2]
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
    }));
}

describe("the search engine list", () => {
    beforeEach(() => {
        state.settings = {};
    });

    it("lists the presets in order and Custom last", () => {
        expect(rows().map((r) => r.id)).toEqual([...SearchEnginePresets.map((p) => p.id), "custom"]);
    });

    it("marks Brave Search, and only it, as recommended, with its reason", () => {
        const all = rows();
        const recommended = all.filter((r) => r.text.includes("Recommended"));
        expect(recommended.map((r) => r.id)).toEqual(["brave"]);
        expect(recommended[0].text).toContain("Its own independent index, no tracking or profiling");
    });

    it("gives every engine a neutral line, Startpage's saying what it does", () => {
        const all = rows();
        expect(all.find((r) => r.id === "startpage").text).toContain("Google results without tracking");
        for (const p of SearchEnginePresets) {
            expect(all.find((r) => r.id === p.id).text, p.id).toContain(p.name);
        }
    });

    it("selects Brave Search while the setting says nothing, as the search does", () => {
        expect(
            rows()
                .filter((r) => r.selected)
                .map((r) => r.id)
        ).toEqual(["brave"]);
    });

    it("selects the engine the user's setting holds, Google included", () => {
        state.settings = { "web:defaultsearch": "https://www.google.com/search?q={query}" };
        expect(
            rows()
                .filter((r) => r.selected)
                .map((r) => r.id)
        ).toEqual(["google"]);
    });

    it("selects Custom for an address no preset has, and names its site", () => {
        state.settings = { "web:defaultsearch": "https://search.example.dev/?q={query}" };
        const selected = rows().filter((r) => r.selected);
        expect(selected.map((r) => r.id)).toEqual(["custom"]);
        expect(selected[0].text).toContain("search.example.dev");
    });

    it("draws the marks as letters, with no image to fetch", () => {
        const html = renderToStaticMarkup(
            <Provider store={createStore()}>
                <SearchEnginePicker />
            </Provider>
        );
        expect(html).not.toMatch(/<img|src=|url\(|https?:\/\//);
        expect(html.match(/data-role="engine-mark"/g)).toHaveLength(SearchEnginePresets.length + 1);
    });
});
