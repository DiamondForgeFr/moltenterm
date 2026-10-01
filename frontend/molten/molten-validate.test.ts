// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { validateMoltenMod, validateMoltenSource } from "./molten-validate";

const ModsDir = "/cfg/mods";

function reader(files: Record<string, string>) {
    return async (path: string) => files[path.slice(ModsDir.length + 1)] ?? null;
}

const manifest = JSON.stringify({ id: "m", name: "M", version: "1.0.0", apiVersion: 1, main: "main.js" });

describe("validateMoltenSource", () => {
    it("accepts the forms of an activate export", () => {
        expect(validateMoltenSource("main.js", "export function activate(api) {}")).toEqual([]);
        expect(validateMoltenSource("main.js", "export async function activate(api) {}")).toEqual([]);
        expect(validateMoltenSource("main.js", "export const activate = (api) => {};")).toEqual([]);
        expect(validateMoltenSource("main.js", "function a() {}\nexport { a as activate };")).toEqual([]);
    });

    it("names the line and column of a syntax error", () => {
        const problems = validateMoltenSource("main.js", "export function activate(api) {\n    let x = ;\n}");
        expect(problems).toEqual([{ file: "main.js", line: 2, column: 13, message: "Unexpected token" }]);
    });

    it("reports a missing activate export", () => {
        expect(validateMoltenSource("main.js", "export function start() {}")).toEqual([
            { file: "main.js", message: "the module does not export an activate(api) function" },
        ]);
    });

    it("reports imports, which cannot resolve from a single file", () => {
        const problems = validateMoltenSource("main.js", 'import x from "./x.js";\nexport function activate() {}');
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatchObject({ file: "main.js", line: 1, column: 1 });
        expect(problems[0].message).toContain("single file");
    });
});

describe("validateMoltenMod", () => {
    it("accepts a valid mod", async () => {
        const result = await validateMoltenMod(
            ModsDir,
            "m",
            reader({ "m/mod.json": manifest, "m/main.js": "export function activate() {}" })
        );
        expect(result).toEqual({ id: "m", ok: true, problems: [] });
    });

    it("reports a missing manifest", async () => {
        const result = await validateMoltenMod(ModsDir, "m", reader({}));
        expect(result.ok).toBe(false);
        expect(result.problems[0]).toMatchObject({ file: "mod.json" });
        expect(result.problems[0].message).toContain("not found");
    });

    it("gives the line of a JSON error in the manifest", async () => {
        const result = await validateMoltenMod(ModsDir, "m", reader({ "m/mod.json": '{\n  "id": "m",\n  oops\n}' }));
        expect(result.problems[0]).toMatchObject({ file: "mod.json", line: 3 });
        expect(result.problems[0].message).toContain("not valid JSON");
    });

    it("reports an unsupported api version with the supported ones", async () => {
        const result = await validateMoltenMod(
            ModsDir,
            "m",
            reader({ "m/mod.json": manifest.replace('"apiVersion":1', '"apiVersion":7') })
        );
        expect(result.problems[0].message).toBe("apiVersion 7 is not supported; supported versions: 1");
    });

    it("reports a missing main file", async () => {
        const result = await validateMoltenMod(ModsDir, "m", reader({ "m/mod.json": manifest }));
        expect(result.problems).toEqual([{ file: "main.js", message: 'main file "main.js" not found' }]);
    });

    it("reports the syntax error of main with its file and line", async () => {
        const result = await validateMoltenMod(
            ModsDir,
            "m",
            reader({ "m/mod.json": manifest, "m/main.js": "export function activate() {\n\n  }}" })
        );
        expect(result.ok).toBe(false);
        expect(result.problems[0]).toMatchObject({ file: "main.js", line: 3 });
    });
});
