// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// No dead setting on the screen (FR-SHELL-096, #1325): every key Preferences shows is read somewhere in the app's code,
// besides the screen itself, the schema and the generated files. A key the code no longer reads is hidden in
// pkg/molten/settingsmeta (it stays in settings.json) or removed from wconfig.SettingsType.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import builtinDefaults from "../../../pkg/wconfig/defaultconfig/settings.json";
import settingsSchema from "../../../schema/settings.json";
import { buildCatalog, SettingsSchema } from "./settings-catalog";

const Root = join(__dirname, "..", "..", "..");
const SourceDirs = ["frontend", "emain", "pkg", "cmd"];
const SourceFile = /\.(ts|tsx|go)$/;
const TestFile = /(\.test\.tsx?|_test\.go)$/;

// What names a key without reading it: the screen that shows it, the schema's sources and the generated files.
const NotReaders = [
    "frontend/moltenterm-shell/settings/",
    "frontend/types/gotypes.d.ts",
    "frontend/app/store/wshclientapi.ts",
    "pkg/wconfig/settingsconfig.go",
    "pkg/wconfig/metaconsts.go",
    "pkg/molten/settingsmeta/",
    "cmd/generateschema/",
];

export type Readers = { literals: Set<string>; goFields: Set<string> };

function walk(dir: string, out: string[]) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name.startsWith(".")) {
            continue;
        }
        const path = join(dir, ent.name);
        if (ent.isDirectory()) {
            walk(path, out);
        } else if (SourceFile.test(ent.name) && !TestFile.test(ent.name)) {
            out.push(path);
        }
    }
}

export function collectReaders(files: { path: string; text: string }[]): Readers {
    const literals = new Set<string>();
    const goFields = new Set<string>();
    for (const { path, text } of files) {
        if (NotReaders.some((p) => path.startsWith(p))) {
            continue;
        }
        for (const m of text.matchAll(/["'`]([a-z][a-z0-9]*:[a-z0-9*]+)["'`]/g)) {
            literals.add(m[1]);
        }
        if (path.endsWith(".go")) {
            for (const m of text.matchAll(/(?:\.|ConfigKey_)([A-Z]\w*)/g)) {
                goFields.add(m[1]);
            }
        }
    }
    return { literals, goFields };
}

// The Go field of each key of wconfig.SettingsType, read by the backend as config.Settings.<Field>.
export function goFieldsByKey(settingsConfigGo: string): Map<string, string> {
    const rtn = new Map<string, string>();
    for (const m of settingsConfigGo.matchAll(/^\s+(\w+)\s+[^`\n]*`json:"([^",]+)/gm)) {
        rtn.set(m[2], m[1]);
    }
    return rtn;
}

export function unreadKeys(keys: string[], readers: Readers, fields: Map<string, string>): string[] {
    return keys.filter((key) => {
        if (readers.literals.has(key)) {
            return false;
        }
        const field = fields.get(key);
        return field == null || !readers.goFields.has(field);
    });
}

// Read while the file is collected, outside the tests' timeout: the scan reads every source file once.
const sources: { path: string; text: string }[] = [];
for (const dir of SourceDirs) {
    const files: string[] = [];
    walk(join(Root, dir), files);
    for (const file of files) {
        sources.push({ path: relative(Root, file).split(sep).join("/"), text: readFileSync(file, "utf8") });
    }
}
const readers = collectReaders(sources);
const fields = goFieldsByKey(readFileSync(join(Root, "pkg/wconfig/settingsconfig.go"), "utf8"));

function shownKeys(): string[] {
    const keys = new Set<string>();
    for (const platform of ["darwin", "linux", "windows"]) {
        for (const entry of buildCatalog(
            settingsSchema as SettingsSchema,
            builtinDefaults as Record<string, unknown>,
            platform
        )) {
            keys.add(entry.key);
        }
    }
    return [...keys];
}

describe("every setting Preferences shows has a reader (FR-SHELL-096)", () => {
    it("finds a reader in the code for each shown key", () => {
        expect(unreadKeys(shownKeys(), readers, fields)).toEqual([]);
    });

    it("reports a key nothing reads, and takes a Go field or a literal as a reader", () => {
        const files = [
            { path: "frontend/app/a.ts", text: `get("app:read")` },
            { path: "pkg/wcore/b.go", text: "x := config.Settings.WindowZoom" },
            { path: "frontend/moltenterm-shell/settings/settings-screen.tsx", text: `"app:screenonly"` },
            { path: "pkg/wconfig/settingsconfig.go", text: "Settings.AppDead" },
        ];
        const goFields = new Map([
            ["window:zoom", "WindowZoom"],
            ["app:dead", "AppDead"],
        ]);
        expect(
            unreadKeys(["app:read", "window:zoom", "app:screenonly", "app:dead"], collectReaders(files), goFields)
        ).toEqual(["app:screenonly", "app:dead"]);
    });

    it("maps the Go fields of wconfig.SettingsType", () => {
        expect(fields.get("tab:background")).toBe("TabBackground");
        expect(fields.get("window:zoom")).toBe("WindowZoom");
    });
});
