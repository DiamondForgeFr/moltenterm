// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MoltenBuiltinMods } from "../../molten-builtins";
import { parseMoltenManifest } from "../../molten-manifest";
import { validateMoltenSource } from "../../molten-validate";
import { activate, parseCopyArgs, textFromStdin } from "./main.js";

function fakeApi() {
    const commands: Record<string, any> = {};
    const boxes: any[] = [];
    const clipboard: string[] = [];
    const api = {
        commands: { register: (name: string, handler: any) => ((commands[name] = handler), () => {}) },
        boxes: { show: (opts: any) => (boxes.push(opts), () => {}) },
        clipboard: { writeText: async (text: string) => void clipboard.push(text) },
    };
    return { api, commands, boxes, clipboard };
}

describe("copy box", () => {
    it("is a valid single-file mod with a supported manifest", () => {
        const builtin = MoltenBuiltinMods.find((m) => m.id === "copy-box");
        expect(parseMoltenManifest("copy-box", builtin.files["mod.json"]).ok).toBe(true);
        expect(validateMoltenSource("main.js", builtin.files["main.js"])).toEqual([]);
    });

    it("parses --title anywhere before the text, and -- before a text starting with dashes", () => {
        expect(parseCopyArgs(["--title", "Token", "abc", "def"])).toEqual({ title: "Token", text: "abc def" });
        expect(parseCopyArgs(["abc", "--title=T"])).toEqual({ title: "T", text: "abc" });
        expect(parseCopyArgs(["--", "--title", "x"])).toEqual({ title: "Copy", text: "--title x" });
        expect(parseCopyArgs([])).toEqual({ title: "Copy", text: "" });
    });

    it("drops one trailing newline from piped text and keeps the others", () => {
        expect(textFromStdin("a\nb\n")).toBe("a\nb");
        expect(textFromStdin("a\r\n")).toBe("a");
        expect(textFromStdin("a\n\n")).toBe("a\n");
        expect(textFromStdin(undefined)).toBe("");
    });

    it("shows a box next to the calling terminal and copies exactly the text", async () => {
        const { api, commands, boxes, clipboard } = fakeApi();
        activate(api);
        const text = "ligne 1 — é\nligne 2 🚀";
        expect(commands.copy({ args: [], stdin: `${text}\n`, blockId: "blk" })).toBe("");
        expect(boxes[0]).toMatchObject({ blockId: "blk", title: "Copy", text, monospace: true });
        await expect(boxes[0].actions[0].run()).resolves.toBe("Copied");
        expect(clipboard).toEqual([text]);
    });

    it("prefers the arguments over stdin and fails when there is nothing to copy", () => {
        const { api, commands, boxes } = fakeApi();
        activate(api);
        commands.copy({ args: ["--title", "Cmd", "ls", "-la"], stdin: "ignored" });
        expect(boxes[0]).toMatchObject({ title: "Cmd", text: "ls -la" });
        expect(commands.copy({ args: [], stdin: "" })).toEqual({
            output: "molten copy: nothing to copy: give a text or pipe one",
            exitCode: 1,
        });
    });
});
