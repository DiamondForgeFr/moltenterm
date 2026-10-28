// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatShortcutById } from "../shortcuts/format";
import { bestMatchIndex, filterPalette, flattenSections, PickerGroupOrder } from "./palette-model";
import {
    actionEntries,
    addressEntry,
    agentCopyEntries,
    agentEntries,
    browserEntries,
    buildPaletteEntries,
    folderEntries,
    paletteGroupTitles,
    panelEntries,
    pushRecentFolder,
    readAgentPresets,
    recentFolderList,
    tildePath,
} from "./palette-sources";

const DefaultAgents = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/presets/agents.json"), "utf8")
);
const DefaultWidgets = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/widgets.json"), "utf8")
);

describe("agent presets", () => {
    it("ships Claude Code and Codex as configuration", () => {
        expect(readAgentPresets(DefaultAgents).map((p) => [p.name, p.command])).toEqual([
            ["Claude Code", "claude"],
            ["Codex", "codex"],
        ]);
    });

    it("reads only agent@ presets with a command, ordered, without hidden ones", () => {
        const presets = {
            "bg@blue": { "display:name": "Blue" },
            "agent@b": { "display:name": "Bee", "display:order": 2, "agent:command": "bee --fast" },
            "agent@a": { "display:order": 1, "agent:command": "aye", "display:icon": "bolt" },
            "agent@none": { "display:name": "No command" },
            "agent@claude": { "display:hidden": true, "agent:command": "claude" },
        } as any;
        const read = readAgentPresets(presets);
        expect(read.map((p) => p.id)).toEqual(["a", "b"]);
        expect(read[0]).toMatchObject({ name: "a", command: "aye" });
    });

    it("gives every agent row the AI icon, whatever its preset says (#1257)", () => {
        const presets = {
            "agent@a": { "agent:command": "aye", "display:icon": "bolt" },
            "agent@b": { "agent:command": "bee" },
        } as any;
        expect(readAgentPresets(presets).map((p) => p.icon)).toEqual(["sparkles", "sparkles"]);
        expect(agentEntries(DefaultAgents).map((e) => e.icon)).toEqual(["sparkles", "sparkles"]);
    });

    it("shows the command as the CLI equivalent", () => {
        const [claude] = agentEntries(DefaultAgents);
        expect(claude).toMatchObject({ group: "agents", label: "Claude Code", cli: "claude" });
        expect(claude.run).toEqual({ kind: "agent", command: "claude" });
    });
});

describe("panels", () => {
    it("lists the default widgets in display order with full names, no shortcut on the terminal (⌘N opens a new panel, #1241), no wsh", () => {
        const panels = panelEntries(DefaultWidgets, "ws1");
        expect(panels.map((p) => p.label)).toEqual([
            "Terminal",
            "Files",
            "Web page",
            "CI/CD",
            "Control room",
            "System info",
            "Processes",
        ]);
        expect(panels.map((p) => p.cli).filter((c) => c)).toEqual([]);
        expect(panels[0].hint).toBeUndefined();
        expect(panels[3].hint).toBeUndefined();
        expect(panels[0].run).toEqual({ kind: "widget", blockdef: DefaultWidgets["defwidget@terminal"].blockdef });
    });

    it("keeps custom widgets, drops hidden ones, launchers and other workspaces' widgets", () => {
        const widgets = {
            "my@logs": { label: "logs", icon: "file", blockdef: { meta: { view: "preview", file: "/var/log" } } },
            "my@hidden": { label: "hidden", "display:hidden": true, blockdef: { meta: { view: "term" } } },
            "my@launcher": { label: "launcher", blockdef: { meta: { view: "launcher" } } },
            "my@elsewhere": { label: "else", workspaces: ["ws2"], blockdef: { meta: { view: "term" } } },
            "my@here": { label: "here", workspaces: ["ws1"], blockdef: { meta: { view: "term" } } },
        } as any;
        expect(panelEntries(widgets, "ws1").map((p) => p.label)).toEqual(["here", "logs"]);
    });
});

describe("recent folders", () => {
    it("records folders newest first, without duplicates, capped", () => {
        expect(pushRecentFolder(["/a", "/b"], "/b")).toEqual(["/b", "/a"]);
        expect(pushRecentFolder(null, "/a")).toEqual(["/a"]);
        expect(pushRecentFolder(["/1", "/2", "/3"], "/4", 3)).toEqual(["/4", "/1", "/2"]);
    });

    it("merges the workspace history with other workspaces' folders, never the current folder", () => {
        expect(recentFolderList("/cur", ["/cur", "/a", "/b"], ["/b", "/c", ""])).toEqual(["/a", "/b", "/c"]);
        expect(recentFolderList("", ["/a", "/b", "/c"], [], 2)).toEqual(["/a", "/b"]);
    });

    it("opens a terminal in the folder, shown with ~", () => {
        const [e] = folderEntries(["/Users/me/APPS/My Project"], "/Users/me");
        expect(e).toMatchObject({
            label: "My Project",
            detail: "~/APPS/My Project",
            run: { kind: "folder", path: "/Users/me/APPS/My Project" },
        });
        expect(e.cli).toBeUndefined();
    });
});

describe("workspace actions", () => {
    it("offers new tab, new workspace, switching to the other workspaces, Getting started and settings", () => {
        const actions = actionEntries([
            { id: "w1", name: "Work", icon: "briefcase", color: "#f00", active: true },
            { id: "w2", name: "Notulia", icon: "book", color: "#0f0", active: false },
        ]);
        expect(actions.map((a) => a.label)).toEqual([
            "New tab",
            "Reopen the last closed pane or tab",
            "Split the panel…",
            "Equalize panels",
            "New workspace",
            "Edit workspace…",
            "Switch to Notulia",
            "Getting started",
            "Sessions",
            "Settings",
            "Keyboard shortcuts",
        ]);
        expect(actions[2].run).toEqual({ kind: "splitplace" });
        expect(actions[3].run).toEqual({ kind: "equalize" });
        expect(actions[3].hint).toBe(formatShortcutById("equalize-panels"));
        expect(actions[6].run).toEqual({ kind: "switchworkspace", workspaceId: "w2" });
        expect(actions.filter((a) => a.cli?.startsWith("wsh "))).toEqual([]);
        expect(actions[0].hint).toBe(formatShortcutById("new-tab"));
        expect(actions[1].hint).toBe(formatShortcutById("reopen-closed"));
    });

    it("gives each workspace entry the rail's badge, imported image and logo included (FR-SHELL-031 AC8)", () => {
        const actions = actionEntries([
            {
                id: "w2",
                name: "Client",
                icon: "book",
                color: "#0f0",
                image: "w2-0123456789ab.png",
                logo: "/p/l.svg",
                active: false,
            },
            { id: "w3", name: "Plain", icon: "", color: "", active: false },
        ]);
        expect(actions.find((a) => a.id === "action:switch:w2").badge).toEqual({
            icon: "book",
            color: "#0f0",
            image: "w2-0123456789ab.png",
            logo: "/p/l.svg",
        });
        expect(actions.find((a) => a.id === "action:switch:w3").badge).toEqual({
            icon: "circle",
            color: "",
            image: "",
            logo: "",
        });
        expect(actions.find((a) => a.id === "action:newtab").badge).toBeUndefined();
    });

    it("always offers Edit workspace…, for the workspace the window shows (FR-SHELL-030)", () => {
        for (const linked of [false, true]) {
            const entry = actionEntries([], linked).find((a) => a.id === "action:editworkspace");
            expect(entry).toMatchObject({
                group: "actions",
                label: "Edit workspace…",
                icon: "pencil",
                run: { kind: "editworkspace" },
            });
            expect(entry.keywords).toEqual(expect.arrayContaining(["rename", "icon", "colour", "color"]));
        }
    });

    it("always offers Getting started, found by its onboarding words", () => {
        const entry = actionEntries([]).find((a) => a.id === "action:gettingstarted");
        expect(entry).toMatchObject({ group: "actions", icon: "compass", run: { kind: "gettingstarted" } });
        expect(entry.keywords).toEqual(expect.arrayContaining(["onboarding", "setup", "welcome"]));
    });

    it("offers the Project tab first in a linked workspace", () => {
        const actions = actionEntries([], true);
        expect(actions.map((a) => a.label)).toEqual([
            "Project tab",
            "New tab",
            "Reopen the last closed pane or tab",
            "Split the panel…",
            "Equalize panels",
            "New workspace",
            "Edit workspace…",
            "Getting started",
            "Sessions",
            "Settings",
            "Keyboard shortcuts",
        ]);
        expect(actions[0].run).toEqual({ kind: "projecttab" });
    });
});

describe("sessions", () => {
    it("opens the Sessions view, found by the words people use for running work", () => {
        const entry = actionEntries([]).find((a) => a.id === "action:sessions");
        expect(entry.run).toEqual({ kind: "sessions" });
        expect(entry.detail).toBe("terminals and agents still running, local and SSH");
        for (const word of ["durable", "running", "agents", "ssh", "detached", "jobs", "processes"]) {
            expect(entry.keywords).toContain(word);
        }
    });
});

describe("agent copy commands", () => {
    it("mentions Claude Code's /copy, which reaches the clipboard through OSC 52", () => {
        const [entry] = agentCopyEntries();
        expect(entry).toMatchObject({ group: "actions", hint: "/copy", run: { kind: "focusorigin" } });
        expect(entry.label).toBe("Copy Claude Code's last answer");
        expect(entry.detail).toContain("OSC 52");
    });

    // #990, TC-SHELL-017-1: codex-cli 0.163.0 has /copy too.
    it("mentions Codex's /copy", () => {
        const entry = agentCopyEntries().find((e) => e.id === "action:agentcopy:codex");
        expect(entry).toMatchObject({ group: "actions", hint: "/copy", run: { kind: "focusorigin" } });
        expect(entry.label).toBe("Copy Codex's last answer");
    });
});

describe("helpers", () => {
    it("shortens the home folder to ~", () => {
        expect(tildePath("/Users/me/x", "/Users/me")).toBe("~/x");
        expect(tildePath("/Users/me", "/Users/me/")).toBe("~");
        expect(tildePath("/Users/meme", "/Users/me")).toBe("/Users/meme");
        expect(tildePath("/x", "")).toBe("/x");
    });

    it("names the agents group after the workspace folder", () => {
        expect(paletteGroupTitles("/Users/me/APPS/MoltenTerm", "/Users/me")).toEqual({
            agents: "Agents in ~/APPS/MoltenTerm",
        });
        expect(paletteGroupTitles("", "/Users/me")).toEqual({});
    });

    it("builds every group from one input", () => {
        const entries = buildPaletteEntries({
            presets: DefaultAgents,
            widgets: DefaultWidgets,
            workspaceId: "ws1",
            folder: "/p",
            recentFolders: ["/p", "/q"],
            otherFolders: [],
            workspaces: [],
            home: "",
        });
        const groups = new Set(entries.map((e) => e.group));
        expect([...groups]).toEqual(["agents", "panels", "folders", "actions"]);
    });
});

describe("browserEntries (FR-BRW-002)", () => {
    it("offers Open in <browser> only with an installed browser and a browser panel in the tab", () => {
        expect(browserEntries(null, true)).toEqual([]);
        expect(browserEntries({ id: "brave", name: "Brave" }, false)).toEqual([]);
        const [entry] = browserEntries({ id: "brave", name: "Brave" }, true);
        expect(entry.label).toBe("Open in Brave");
        expect(entry.cli).toBe("molten open <url> --browser brave");
        expect(entry.run).toEqual({ kind: "openinbrowser" });
        expect(browserEntries({ id: "custom", name: "Thorium" }, true)[0].cli).toBe(
            "molten open <url> --browser installed"
        );
    });
});

describe("the address row (#1229)", () => {
    const entries = () =>
        buildPaletteEntries({
            presets: DefaultAgents,
            widgets: DefaultWidgets,
            workspaceId: "ws1",
            folder: "/p",
            recentFolders: ["/p"],
            otherFolders: [],
            workspaces: [],
            home: "",
        });
    const firstRow = (query: string) => {
        const listed = [addressEntry(query), ...entries()].filter((e) => e != null);
        const sections = filterPalette(listed, query, {}, PickerGroupOrder);
        const flat = flattenSections(sections);
        return { first: flat[0], selected: flat[bestMatchIndex(sections, query)] };
    };

    it.each([
        ["github.com", "Open github.com", "https://github.com"],
        ["localhost:3000", "Open localhost:3000", "http://localhost:3000"],
        ["https://example.com/x", "Open https://example.com/x", "https://example.com/x"],
    ])("puts Open %s first and selected, and Enter opens a web page panel on it", (typed, label, url) => {
        const { first, selected } = firstRow(typed);
        expect(first.label).toBe(label);
        expect(selected.id).toBe(first.id);
        expect(first.run).toEqual({ kind: "widget", blockdef: { meta: { view: "molten-browser", url } } });
    });

    it("leaves a plain word to the usual filter", () => {
        expect(addressEntry("terminal")).toBeNull();
        expect(addressEntry("open the files")).toBeNull();
        expect(firstRow("term").first.label).toBe("Terminal");
    });
});
