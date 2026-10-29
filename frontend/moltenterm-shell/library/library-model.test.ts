// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import {
    libraryAddAsk,
    librarySectionAt,
    LibrarySections,
    liveAgents,
    matchesQuery,
    panelAboutKey,
    PublicDownloadUrl,
    putAwayAgentNames,
    sentToAiRows,
    suggestClipboardText,
    whenText,
    workspaceAgents,
} from "./library-model";

function lookup(dict: any, key: string): unknown {
    return key.split(".").reduce((node, part) => node?.[part], dict);
}

describe("library sections (FR-SHELL-088)", () => {
    it("names every section in both languages", () => {
        for (const s of LibrarySections) {
            for (const part of ["label", "title", "sub"]) {
                const key = `library.sections.${s.key}.${part}`;
                expect(typeof lookup(en, key), key).toBe("string");
                expect(typeof lookup(fr, key), key).toBe("string");
            }
        }
        expect(LibrarySections.map((s) => s.id)).toEqual(["workspaces", "panels", "ai", "putaway", "settings"]);
    });

    it("walks the navigation with the arrows, round the ends", () => {
        expect(librarySectionAt("workspaces", 1)).toBe("panels");
        expect(librarySectionAt("workspaces", -1)).toBe("settings");
        expect(librarySectionAt("settings", 1)).toBe("workspaces");
    });

    it("explains each built-in panel kind in plain words, in both languages", () => {
        for (const view of [
            "term",
            "preview",
            "molten-browser",
            "molten-reviews",
            "molten-project",
            "molten-sessions",
        ]) {
            const key = panelAboutKey(view);
            expect(typeof lookup(en, key), view).toBe("string");
            expect(typeof lookup(fr, key), view).toBe("string");
        }
        expect(panelAboutKey("my-custom-widget")).toBeNull();
    });
});

describe("Suggest MoltenTerm", () => {
    it("copies the public download link and nothing else", () => {
        expect(suggestClipboardText()).toBe(PublicDownloadUrl);
        expect(PublicDownloadUrl).toBe("https://github.com/DiamondForgeFr/moltenterm/releases/latest");
    });
});

describe("search", () => {
    it("needs every word, accents and case aside", () => {
        expect(matchesQuery(["Revue PR", "Molten Spaces", "Olivia"], "revue olivia")).toBe(true);
        expect(matchesQuery(["Réglages"], "reglages")).toBe(true);
        expect(matchesQuery(["Revue PR"], "revue codex")).toBe(false);
        expect(matchesQuery(["anything"], "  ")).toBe(true);
    });

    it("names a put-away view's agents", () => {
        expect(
            putAwayAgentNames({
                id: "a",
                at: 1,
                workspaceid: "w",
                name: "v",
                panels: [],
                agents: [
                    { agent: "claude", name: "Olivia", command: "claude --resume x" },
                    { agent: "codex", command: "codex resume --last" },
                ],
            })
        ).toEqual(["Olivia", "codex"]);
    });
});

describe("Sent to AI", () => {
    const panel = (id: string, ws: string, held: any[], tabs: any[]) => ({
        panelBlockId: id,
        tabId: "t-" + id,
        workspaceId: ws,
        agentTabs: held,
        browserTabs: tabs,
    });

    it("lists the shared pages first, then the opened ones, the most recent first", () => {
        const rows = sentToAiRows([
            panel(
                "p1",
                "w1",
                [
                    { browsertabid: "a", agentname: "Olivia", origin: "agent", state: "active", since: 300 },
                    { browsertabid: "b", agentname: "Olivia", origin: "shared", state: "active", since: 100 },
                    { browsertabid: "gone", agentname: "Olivia", origin: "shared", state: "active", since: 999 },
                ],
                [
                    { id: "a", url: "https://a.example", title: "A" },
                    { id: "b", url: "https://b.example", title: " " },
                ]
            ),
            panel(
                "p2",
                "w2",
                [{ browsertabid: "c", agentname: "Valentin", origin: "shared", state: "active", since: 200 }],
                [{ id: "c", url: "https://c.example", title: "C" }]
            ),
        ]);
        expect(rows.map((r) => r.browserTabId)).toEqual(["c", "b", "a"]);
        expect(rows[1].title).toBe("https://b.example");
        expect(rows[0]).toMatchObject({ agentName: "Valentin", workspaceId: "w2", shared: true, panelBlockId: "p2" });
        expect(rows[2].shared).toBe(false);
    });
});

describe("workspace agents", () => {
    const data = {
        versions: {},
        states: {
            b1: { blockid: "b1", workspaceid: "w", state: "idle", version: 1, started: 1 },
            b2: { blockid: "b2", workspaceid: "w", state: "waiting", version: 1, started: 2 },
            b3: { blockid: "b3", workspaceid: "w", state: "working", version: 1, started: 3 },
            b4: { blockid: "b4", workspaceid: "other", state: "working", version: 1 },
        },
    } as any;

    it("puts the agents that need the developer first and counts the live ones", () => {
        const agents = workspaceAgents(data, "w");
        expect(agents.map((a) => a.blockid)).toEqual(["b2", "b3", "b1"]);
        expect(liveAgents(agents)).toBe(2);
    });
});

describe("when", () => {
    it("says the time today and the day before", () => {
        const now = new Date(2026, 9, 27, 18, 30).getTime();
        expect(whenText(new Date(2026, 9, 27, 9, 5).getTime(), now, "en-GB")).toBe("09:05");
        expect(whenText(new Date(2026, 9, 26, 9, 5).getTime(), now, "en-GB")).toBe("26 Oct · 09:05");
        expect(whenText(0, now, "en")).toBe("");
    });
});

describe("Add to on a pinned view (FR-SHELL-094)", () => {
    it("asks first on a pinned view, naming what changes", () => {
        expect(libraryAddAsk("workspace", false)).toBe("library.panels.askPinned");
        expect(libraryAddAsk("temporary", true)).toBe("library.panels.askPinned");
        expect(libraryAddAsk("everywhere", false)).toBe("library.panels.askEverywhere");
    });

    it("adds at once to a temporary view", () => {
        expect(libraryAddAsk("temporary", false)).toBeNull();
    });

    it("has the questions in both languages, naming the view", () => {
        for (const key of ["library.panels.askPinned", "library.panels.askEverywhere"]) {
            expect(lookup(en, key)).toContain("{view}");
            expect(lookup(fr, key)).toContain("{view}");
        }
    });
});
