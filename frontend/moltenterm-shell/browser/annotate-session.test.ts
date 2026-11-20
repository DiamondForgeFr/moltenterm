// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import { annotatablePage, annotateLayers, AnnotateSession, closedTabs } from "./annotate-session";

describe("the annotate session of a panel (#2327)", () => {
    it("annotates only pages of the web", () => {
        expect(annotatablePage("http://localhost:5173/")).toBe(true);
        expect(annotatablePage("https://example.test/a?b=1")).toBe(true);
        for (const url of ["about:blank", "file:///etc/hosts", "javascript:alert(1)", "", "not a url"]) {
            expect(annotatablePage(url)).toBe(false);
        }
    });

    it("starts on a page of the web, once per tab, and each start is a new session", () => {
        const session = new AnnotateSession();
        expect(session.isOpen("tab-1")).toBe(false);
        expect(session.start("tab-1", "http://localhost:5173/")).toBe(true);
        expect(globalStore.get(session.openAtom)).toMatchObject([
            { tabId: "tab-1", url: "http://localhost:5173/", nonce: 1 },
        ]);
        expect(session.start("tab-1", "http://localhost:5173/")).toBe(false);
        session.close("tab-1");
        expect(session.isOpen("tab-1")).toBe(false);
        expect(session.start("tab-1", "https://example.test/")).toBe(true);
        expect(session.opens()[0].nonce).toBe(2);
    });

    it("does not start on a page that is no page of the web", () => {
        const session = new AnnotateSession();
        for (const url of ["", "about:blank", "file:///etc/hosts", "data:text/html,x"]) {
            expect(session.start("tab-1", url)).toBe(false);
        }
        expect(session.opens()).toEqual([]);
    });

    it("keeps a session for each tab: another tab's start leaves the first one's as it is", () => {
        const session = new AnnotateSession();
        session.start("tab-a", "http://localhost:1/");
        expect(session.start("tab-b", "http://localhost:2/")).toBe(true);
        expect(session.opens().map((o) => o.tabId)).toEqual(["tab-a", "tab-b"]);
        session.close("tab-b");
        expect(session.opens().map((o) => o.tabId)).toEqual(["tab-a"]);
    });

    it("takes the focus the panel would give to the page of a tab, only while that tab's layer shows", () => {
        const session = new AnnotateSession();
        expect(session.holdFocus("tab-a")).toBe(false);
        session.focusLayers.set("tab-a", () => true);
        session.focusLayers.set("tab-b", () => false);
        expect(session.holdFocus("tab-a")).toBe(true);
        expect(session.holdFocus("tab-b")).toBe(false);
        expect(session.holdFocus("tab-c")).toBe(false);
        session.focusLayers.delete("tab-a");
        expect(session.holdFocus("tab-a")).toBe(false);
    });

    it("keeps the sessions of two panels apart", () => {
        const a = new AnnotateSession();
        const b = new AnnotateSession();
        a.start("tab-a", "http://localhost:1/");
        expect(b.isOpen("tab-a")).toBe(false);
    });

    it("counts the comments pending in each tab, for the Comment button, and forgets them when the session ends (#2422)", () => {
        const session = new AnnotateSession();
        session.start("tab-a", "http://localhost:1/");
        session.start("tab-b", "http://localhost:2/");
        session.setCount("tab-a", 3);
        session.setCount("tab-b", 1);
        expect(globalStore.get(session.countsAtom)).toEqual({ "tab-a": 3, "tab-b": 1 });
        session.setCount("tab-b", 0);
        expect(globalStore.get(session.countsAtom)).toEqual({ "tab-a": 3 });
        session.close("tab-a");
        expect(globalStore.get(session.countsAtom)).toEqual({});
    });

    it("leaves through the layer when it is mounted, which asks before comments are lost, and at once when it is not", () => {
        const session = new AnnotateSession();
        session.start("tab-a", "http://localhost:1/");
        const asked: string[] = [];
        session.leaveLayers.set("tab-a", () => asked.push("ask"));
        session.leave("tab-a");
        expect(asked).toEqual(["ask"]);
        expect(session.isOpen("tab-a")).toBe(true);
        session.leaveLayers.delete("tab-a");
        session.leave("tab-a");
        expect(session.isOpen("tab-a")).toBe(false);
    });

    it("has no page for a tab until the panel says where they are", () => {
        const session = new AnnotateSession();
        expect(session.webviewOf("tab-a")).toBeNull();
    });
});

// A tab change never discards what the developer drew (FR-BRW-017 AC13): the layer of the annotated tab stays, hidden,
// while another tab is shown, and shows again with its zones.
describe("the layers over the tabs", () => {
    const opens = [
        { tabId: "tab-a", url: "http://localhost:1/", nonce: 1 },
        { tabId: "tab-b", url: "http://localhost:2/", nonce: 2 },
    ];

    it("shows the layer of the shown tab and keeps the other one mounted, hidden", () => {
        expect(annotateLayers(opens, "tab-a", ["tab-a", "tab-b", "tab-c"]).map((l) => [l.open.tabId, l.shown])).toEqual(
            [
                ["tab-a", true],
                ["tab-b", false],
            ]
        );
    });

    it("keeps the annotated tab's layer through a visit to another tab, and shows it again when the tab is back", () => {
        const tabs = ["tab-a", "tab-b"];
        const one = [opens[0]];
        expect(annotateLayers(one, "tab-b", tabs)).toEqual([{ open: opens[0], shown: false }]);
        expect(annotateLayers(one, "tab-a", tabs)).toEqual([{ open: opens[0], shown: true }]);
    });

    it("keeps the same session, so the same layer and its zones, whichever tab is shown", () => {
        const tabs = ["tab-a", "tab-b"];
        expect(annotateLayers(opens, "tab-a", tabs).map((l) => l.open.nonce)).toEqual([1, 2]);
        expect(annotateLayers(opens, "tab-b", tabs).map((l) => l.open.nonce)).toEqual([1, 2]);
    });

    it("drops the layer of a tab that was closed, and says which session ended", () => {
        expect(annotateLayers(opens, "tab-b", ["tab-b"]).map((l) => l.open.tabId)).toEqual(["tab-b"]);
        expect(closedTabs(opens, ["tab-b"])).toEqual(["tab-a"]);
        expect(closedTabs(opens, ["tab-a", "tab-b"])).toEqual([]);
    });
});
