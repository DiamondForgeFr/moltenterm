// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    actionEntries,
    agentCopyEntries,
    agentEntries,
    buildPaletteEntries,
    folderEntries,
    paletteGroupTitles,
    panelEntries,
    pushRecentFolder,
    readAgentPresets,
    recentFolderList,
    shellPath,
    shellQuote,
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
        expect(read[0]).toMatchObject({ name: "a", icon: "bolt", command: "aye" });
        expect(read[1].icon).toBe("robot");
    });

    it("shows the command as the CLI equivalent", () => {
        const [claude] = agentEntries(DefaultAgents);
        expect(claude).toMatchObject({ group: "agents", label: "Claude Code", cli: "claude" });
        expect(claude.run).toEqual({ kind: "agent", command: "claude" });
    });
});

describe("panels", () => {
    it("lists the default widgets in display order with full names and wsh launch", () => {
        const panels = panelEntries(DefaultWidgets, "ws1");
        expect(panels.map((p) => p.label)).toEqual([
            "Terminal",
            "Files",
            "Web",
            "Timeline",
            "CI/CD",
            "System info",
            "Processes",
        ]);
        expect(panels[3].cli).toBe("wsh launch defwidget@timeline");
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
            cli: "wsh term ~/'APPS/My Project'",
            run: { kind: "folder", path: "/Users/me/APPS/My Project" },
        });
    });
});

describe("workspace actions", () => {
    it("offers new tab, new workspace, switching to the other workspaces and settings", () => {
        const actions = actionEntries([
            { id: "w1", name: "Work", icon: "briefcase", color: "#f00", active: true },
            { id: "w2", name: "Notulia", icon: "book", color: "#0f0", active: false },
        ]);
        expect(actions.map((a) => a.label)).toEqual(["New tab", "New workspace", "Switch to Notulia", "Settings"]);
        expect(actions[2].run).toEqual({ kind: "switchworkspace", workspaceId: "w2" });
        expect(actions[3].cli).toBe("wsh editconfig");
    });
});

describe("agent copy commands", () => {
    it("mentions Claude Code's /copy, which reaches the clipboard through OSC 52", () => {
        const [entry] = agentCopyEntries();
        expect(entry).toMatchObject({ group: "actions", hint: "/copy", run: { kind: "focusorigin" } });
        expect(entry.label).toBe("Copy Claude Code's last answer");
        expect(entry.detail).toContain("OSC 52");
    });
});

describe("helpers", () => {
    it("quotes shell arguments only when needed", () => {
        expect(shellQuote("defwidget@web")).toBe("defwidget@web");
        expect(shellQuote("~/a b")).toBe("'~/a b'");
        expect(shellQuote("it's")).toBe(`'it'\\''s'`);
        expect(shellQuote("")).toBe("''");
    });

    it("keeps ~ outside the quotes of a shell path", () => {
        expect(shellPath("/Users/me/a b", "/Users/me")).toBe("~/'a b'");
        expect(shellPath("/Users/me/ab", "/Users/me")).toBe("~/ab");
        expect(shellPath("/Users/me", "/Users/me")).toBe("~");
        expect(shellPath("/tmp/a b", "/Users/me")).toBe("'/tmp/a b'");
    });

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
