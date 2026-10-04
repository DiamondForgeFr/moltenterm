// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// `molten mod validate` (FR-MORPH-005). The module is parsed, never imported: validation must not run code the user
// has not trusted yet (FR-MORPH-004).

import { parse } from "acorn";
import { MoltenManifestFileName, parseMoltenManifest } from "./molten-manifest";

// must match MoltenValidationProblem in cmd/wsh/cmd/wshcmd-molten.go
export type MoltenValidationProblem = {
    file: string;
    line?: number;
    column?: number;
    message: string;
    // A warning is reported but never fails validation.
    severity?: "warning";
};

// What `molten` needs to check a Claude Code part with the user's own claude (FR-MORPH-010).
export type MoltenAgentPartInfo = {
    folder: string;
    path: string;
    targetversion: string;
};

export type MoltenValidationResult = {
    id: string;
    ok: boolean;
    problems: MoltenValidationProblem[];
    agents?: { "claude-code"?: MoltenAgentPartInfo };
};

export const MoltenPluginManifestPath = ".claude-plugin/plugin.json";

export type MoltenValidateReader = (path: string) => Promise<string>;

// V8 reports JSON errors by character position; agents fix files faster with a line and column.
function jsonErrorLocation(text: string, message: string): { line?: number; column?: number } {
    const lineCol = /line (\d+) column (\d+)/.exec(message);
    if (lineCol) {
        return { line: Number(lineCol[1]), column: Number(lineCol[2]) };
    }
    const position = /position (\d+)/.exec(message);
    if (!position) {
        return {};
    }
    const before = text.slice(0, Number(position[1]));
    const lines = before.split("\n");
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function exportsActivate(program: any): boolean {
    for (const node of program.body) {
        if (node.type !== "ExportNamedDeclaration") {
            continue;
        }
        const decl = node.declaration;
        if (decl?.type === "FunctionDeclaration" && decl.id?.name === "activate") {
            return true;
        }
        if (decl?.type === "VariableDeclaration" && decl.declarations.some((d: any) => d.id?.name === "activate")) {
            return true;
        }
        if ((node.specifiers ?? []).some((s: any) => (s.exported?.name ?? s.exported?.value) === "activate")) {
            return true;
        }
    }
    return false;
}

export function validateMoltenSource(file: string, source: string): MoltenValidationProblem[] {
    let program: any;
    try {
        program = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
    } catch (e) {
        const loc = e?.loc;
        return [
            {
                file,
                line: loc?.line,
                column: loc != null ? loc.column + 1 : undefined,
                message: String(e?.message ?? e).replace(/ \(\d+:\d+\)$/, ""),
            },
        ];
    }
    const problems: MoltenValidationProblem[] = [];
    for (const node of program.body) {
        if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.source != null) {
            problems.push({
                file,
                line: node.loc.start.line,
                column: node.loc.start.column + 1,
                message: "a mod is a single file: import and re-export from other modules are not supported",
            });
        }
    }
    if (!exportsActivate(program)) {
        problems.push({ file, message: "the module does not export an activate(api) function" });
    }
    return problems;
}

export async function validateMoltenMod(
    modsDir: string,
    id: string,
    readTextFile: MoltenValidateReader
): Promise<MoltenValidationResult> {
    const dir = `${modsDir}/${id}`;
    const fail = (problems: MoltenValidationProblem[]): MoltenValidationResult => ({ id, ok: false, problems });
    const manifestText = await readTextFile(`${dir}/${MoltenManifestFileName}`);
    if (manifestText == null) {
        return fail([{ file: MoltenManifestFileName, message: `${MoltenManifestFileName} not found in ${dir}` }]);
    }
    const parsed = parseMoltenManifest(id, manifestText);
    if (parsed.ok === false) {
        let location = {};
        try {
            JSON.parse(manifestText);
        } catch (e) {
            location = jsonErrorLocation(manifestText, String(e?.message ?? ""));
        }
        return fail([{ file: MoltenManifestFileName, ...location, message: parsed.error }]);
    }
    const main = parsed.manifest.main;
    const source = await readTextFile(`${dir}/${main}`);
    const problems =
        source == null ? [{ file: main, message: `main file "${main}" not found` }] : validateMoltenSource(main, source);
    const result: MoltenValidationResult = { id, ok: false, problems };
    const part = parsed.manifest.agents?.["claude-code"];
    if (part != null) {
        problems.push(...(await validateClaudeCodePart(dir, id, part.folder, readTextFile)));
        result.agents = {
            "claude-code": { folder: part.folder, path: `${dir}/${part.folder}`, targetversion: part.targetVersion },
        };
    }
    result.ok = !problems.some((p) => p.severity !== "warning");
    return result;
}

// The Claude Code part is checked here as far as reading files goes; `molten` then runs `claude plugin validate`,
// which knows the plugin API of the installed version.
export async function validateClaudeCodePart(
    dir: string,
    id: string,
    folder: string,
    readTextFile: MoltenValidateReader
): Promise<MoltenValidationProblem[]> {
    const file = `${folder}/${MoltenPluginManifestPath}`;
    const text = await readTextFile(`${dir}/${file}`);
    if (text == null) {
        return [
            {
                file,
                message: `the Claude Code part has no plugin manifest: ${file} not found (molten mod new --claude-code writes one)`,
            },
        ];
    }
    let manifest: any;
    try {
        manifest = JSON.parse(text);
    } catch (e) {
        const message = String(e?.message ?? e);
        return [{ file, ...jsonErrorLocation(text, message), message: `not valid JSON: ${message}` }];
    }
    if (manifest?.name !== id) {
        return [
            {
                file,
                message: `"name" is ${JSON.stringify(manifest?.name ?? null)} but must be the mod id "${id}", so that every loaded part has its own name`,
            },
        ];
    }
    return [];
}
