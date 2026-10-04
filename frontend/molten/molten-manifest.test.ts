// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseMoltenManifest } from "./molten-manifest";

const valid = {
    id: "hello",
    name: "Hello",
    version: "1.0.0",
    description: "Says hello",
    apiVersion: 1,
    main: "main.js",
    capabilities: ["commands"],
};

function parse(manifest: any, folder = "hello") {
    return parseMoltenManifest(folder, JSON.stringify(manifest));
}

describe("parseMoltenManifest", () => {
    it("accepts a valid manifest", () => {
        expect(parse(valid)).toEqual({ ok: true, manifest: valid });
    });

    it("fills the optional fields", () => {
        const { description, capabilities, ...minimal } = valid;
        const result = parse(minimal);
        expect(result.ok && result.manifest.description).toBe("");
        expect(result.ok && result.manifest.capabilities).toEqual([]);
    });

    it("rejects invalid JSON", () => {
        const result = parseMoltenManifest("hello", "{ not json");
        expect(result).toMatchObject({ ok: false, refused: false });
        expect(result.ok === false && result.error).toContain("not valid JSON");
    });

    it.each(["id", "name", "version", "main"])("rejects a missing %s", (field) => {
        const result = parse({ ...valid, [field]: undefined });
        expect(result.ok === false && result.error).toContain(`"${field}"`);
    });

    it("rejects an id that does not match its folder", () => {
        const result = parse(valid, "other");
        expect(result.ok === false && result.error).toContain('the folder is "other"');
    });

    it("rejects an id with uppercase letters", () => {
        expect(parse({ ...valid, id: "Hello" }, "Hello").ok).toBe(false);
    });

    it.each(["../evil.js", "/abs/main.js", "./main.js", "main.ts", "lib/../main.js"])("rejects main %s", (main) => {
        const result = parse({ ...valid, main });
        expect(result.ok === false && result.error).toContain('"main"');
    });

    it("accepts main in a subfolder", () => {
        expect(parse({ ...valid, main: "dist/main.mjs" }).ok).toBe(true);
    });

    it("rejects capabilities that are not strings", () => {
        expect(parse({ ...valid, capabilities: [1] }).ok).toBe(false);
    });

    it("refuses an unsupported apiVersion and names the supported ones", () => {
        const result = parse({ ...valid, apiVersion: 2 });
        expect(result).toMatchObject({ ok: false, refused: true });
        expect(result.ok === false && result.error).toBe("apiVersion 2 is not supported; supported versions: 1");
    });

    it("reads a Claude Code part", () => {
        const agents = { "claude-code": { folder: "agents/claude-code", targetVersion: "2.1.289" } };
        expect(parse({ ...valid, agents })).toEqual({ ok: true, manifest: { ...valid, agents } });
    });

    it.each([
        [[], '"agents" must be an object'],
        [{ codex: {} }, 'agent "codex" is not supported; supported: claude-code'],
        [{ "claude-code": { targetVersion: "2.1.289" } }, '"agents.claude-code.folder" must be a non-empty string'],
        [{ "claude-code": { folder: "../out", targetVersion: "2.1.289" } }, 'no "." or ".." segment'],
        [{ "claude-code": { folder: "/abs", targetVersion: "2.1.289" } }, "relative path inside the mod folder"],
        [{ "claude-code": { folder: "agents/claude-code", targetVersion: "2.1" } }, "MAJOR.MINOR.PATCH"],
    ])("rejects agents %j", (agents, message) => {
        const result = parse({ ...valid, agents });
        expect(result).toMatchObject({ ok: false, refused: false });
        expect(result.ok === false && result.error).toContain(message);
    });

    it("refuses a missing apiVersion", () => {
        const result = parse({ ...valid, apiVersion: undefined });
        expect(result).toMatchObject({ ok: false, refused: true });
    });
});
