// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A view with no name of its own takes its site's name (#1962, FR-SHELL-081 AC21-AC29, FR-SHELL-056): the domain without "www."
// and without a "Web page ·" prefix, following the page the panel shows now; the page's title goes to the tooltip.

import { describe, expect, it } from "vitest";
import { numberDuplicateViewNames, panelTitle, panelViewName, tabDisplayName } from "./tab-identity";
import { tabTooltip } from "./tab-identity-ui";

// Wave's own web view, which only layouts saved before MoltenTerm's browser panel still hold.
const WaveWebView = "web";

const page = (url: string, opened = "https://opened-at.test/") => ({
    view: "molten-browser",
    url: opened,
    "molten:browser:tabs": [{ id: "t1", url, title: "Inbox (3)" }],
    "molten:browser:active": "t1",
});

describe("the name of a view of a page (#1962)", () => {
    it("is the site's domain, without www and without the kind", () => {
        expect(panelViewName(page("https://www.notion.so/workspace"))).toBe("notion.so");
        expect(panelViewName({ view: WaveWebView, url: "https://linear.app/team" })).toBe("linear.app");
        expect(panelTitle(page("https://www.notion.so/workspace"))).toBe("notion.so");
    });

    it("follows the page the panel shows now, not the address it opened at", () => {
        expect(panelViewName(page("https://mail.google.com/inbox", "https://notion.so/"))).toBe("mail.google.com");
    });

    it("falls back to the kind for a panel with no web address yet, and leaves other kinds as they were", () => {
        expect(panelViewName({ view: "molten-browser" })).toBe("Web page");
        expect(panelViewName({ view: "term", "cmd:cwd": "/src/api" })).toBe("Terminal · api");
        expect(panelViewName({ view: "preview", file: "/src/api" })).toBe("Files · api");
    });

    it("is what a view still under Wave's generic name shows, and never overrides a name the user typed", () => {
        const meta = page("https://notion.so/a");
        expect(tabDisplayName("T4", meta)).toBe("notion.so");
        expect(tabDisplayName("Compta", meta)).toBe("Compta");
    });

    it("numbers two views of the same site, never a lone one or a name the user typed", () => {
        const names = numberDuplicateViewNames([
            { id: "a", name: "mail.google.com", derived: true },
            { id: "b", name: "mail.google.com", derived: true },
            { id: "c", name: "notion.so", derived: true },
            { id: "d", name: "mail.google.com", derived: false },
        ]);
        expect(names.get("a")).toBe("mail.google.com 2");
        expect(names.get("b")).toBe("mail.google.com 3");
        expect(names.get("c")).toBe("notion.so");
        expect(names.get("d")).toBe("mail.google.com");
    });
});

describe("the tooltip of a view of pages (#1962)", () => {
    const t = ((key: string) => key) as any;
    const identity = { name: "notion.so", icon: "globe", pinned: false, agent: null, agents: [], reviewDone: null };

    it("starts with the title and the site of each page the view shows", () => {
        const pages = "My space · notion.so\nTeam · linear.app";
        expect(tabTooltip(t, { ...identity, pages }, "", 0)).toBe(pages);
        expect(tabTooltip(t, { ...identity, pages }, "term trees", 0)).toBe(`${pages}\nterm trees`);
    });

    it("is unchanged for a view with no page", () => {
        expect(tabTooltip(t, identity, "", 0)).toBe("");
        expect(tabTooltip(t, { ...identity, pages: "" }, "trees", 0)).toBe("trees");
    });
});
