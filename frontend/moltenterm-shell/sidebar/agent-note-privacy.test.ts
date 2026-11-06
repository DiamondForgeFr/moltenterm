// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agent note is the developer's alone (FR-SHELL-084, #2008): never sent to the agent, typed into its terminal,
// written to its session or put in a handoff, and no other surface uses it for now. The note's code is the sidebar's
// agent rows and the backend's cleanup when a terminal closes; any other file that names it is a new way for it to
// travel, and this test asks for it to be looked at.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const Root = path.resolve(__dirname, "../../..");
const ScannedDirs = ["frontend", "emain", "cmd", "pkg"];

// Whoever touches the note: its model, store and rows, their tests, and the backend that drops it with the terminal.
const Allowed = [
    /^frontend\/moltenterm-shell\/sidebar\/agent-note-[\w.-]+\.tsx?$/,
    /^frontend\/moltenterm-shell\/sidebar\/sidebar-agents\.tsx$/,
    /^frontend\/moltenterm-shell\/sidebar\/sidebar-agents\.css$/,
    /^frontend\/moltenterm-shell\/i18n\/locales\/(en|fr)\.json$/,
    /^pkg\/molten\/agentstate\.go$/,
    /^pkg\/molten\/attention\/agentnotes(_test)?\.go$/,
    /^pkg\/molten\/attention\/agentroute\.go$/,
    /^pkg\/molten\/metaguard\/metaguard_test\.go$/,
];

// The note's names, in either language of the code: its meta key and constant, its modules, its model.
const Mention = /molten:agentnotes|AgentNotesMetaKey|agent-note-(?:model|store|ui)|AgentNotesModel/;

function files(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(path.join(Root, dir), { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...files(rel));
        else if (/\.(ts|tsx|go|css|json)$/.test(entry.name)) out.push(rel);
    }
    return out;
}

describe("where the note is named", () => {
    const all = ScannedDirs.flatMap(files);
    const mentioning = all.filter((file) => Mention.test(fs.readFileSync(path.join(Root, file), "utf8")));

    it("scans the code", () => {
        expect(all.length).toBeGreaterThan(1000);
    });

    it("is the sidebar's agent rows and the backend's cleanup, and nothing else", () => {
        const strangers = mentioning.filter((file) => !Allowed.some((re) => re.test(file)));
        expect(strangers).toEqual([]);
    });

    it("is there: the feature's own files name it", () => {
        for (const file of [
            "frontend/moltenterm-shell/sidebar/agent-note-model.ts",
            "frontend/moltenterm-shell/sidebar/agent-note-store.ts",
            "frontend/moltenterm-shell/sidebar/agent-note-ui.tsx",
            "frontend/moltenterm-shell/sidebar/sidebar-agents.tsx",
            "pkg/molten/agentstate.go",
            "pkg/molten/attention/agentnotes.go",
        ]) {
            expect(mentioning).toContain(file);
        }
    });
});

describe("what the note's code calls", () => {
    const read = (file: string) => fs.readFileSync(path.join(Root, file), "utf8");
    const code = (file: string) =>
        read(file)
            .split("\n")
            .filter((line) => !line.trim().startsWith("//"))
            .join("\n");

    it("is a meta write on the workspace: the store reaches no terminal, no session, no handoff and no agent", () => {
        const store = code("frontend/moltenterm-shell/sidebar/agent-note-store.ts");
        const calls = [...store.matchAll(/RpcApi\.(\w+)/g)].map((m) => m[1]);
        expect(calls).toEqual(["SetMetaCommand"]);
        expect(store).toContain('makeORef("workspace"');
        expect(store).not.toMatch(/ControllerInput|wshRpcCall|handoff|Handoff|sendToAgent|molten:agent/);
    });

    it("keeps the note out of the sidebar's agent text: the row's title and facts take none of it", () => {
        const rows = read("frontend/moltenterm-shell/sidebar/sidebar-agents.tsx");
        const title = rows.slice(rows.indexOf("title={["), rows.indexOf('data-testid="sidebar-agent-row"'));
        expect(title).toContain("agentFactsLine");
        expect(title).not.toMatch(/note/i);
    });

    it("is dropped by the backend with the terminal it was written for, which tells no agent", () => {
        const go = code("pkg/molten/attention/agentnotes.go");
        expect(go).toContain("molten.AgentNotesMetaKey");
        expect(go).not.toMatch(/ControllerInput|SendInput|handoff|agenthook/i);
    });
});
