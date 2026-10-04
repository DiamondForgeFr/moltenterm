// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { browserBlockDef, MoltentermBrowserView, readBrowserState } from "./browser-model";

const RepoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// Wave's web view keeps its own code (and its help view, which reuses it); previews and mocks render it on purpose.
const AllowedWebViewFiles = new Set([
    "frontend/app/view/webview/webview.tsx",
    "frontend/preview/previews/widgets.preview.tsx",
    "frontend/preview/mock/mockwaveenv.ts",
]);

const LegacyWebCreation = [/view:\s*"web"/, /MetaKey_View:\s*"web"/, /"view":\s*"web"/];

function sourceFiles(dir: string): string[] {
    const rtn: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            rtn.push(...sourceFiles(path));
            continue;
        }
        if (/\.(ts|tsx|go|json)$/.test(name) && !/(\.test\.ts|_test\.go)$/.test(name)) {
            rtn.push(path);
        }
    }
    return rtn;
}

describe("web pages open in the browser panel (#132)", () => {
    it("builds a browser panel whose single tab is the URL", () => {
        const def = browserBlockDef("https://example.com/a");
        expect(def.meta.view).toBe(MoltentermBrowserView);
        const state = readBrowserState(def.meta, "about:blank", () => "t1");
        expect(state).toEqual({ tabs: [{ id: "t1", url: "https://example.com/a" }], activeId: "t1" });
    });

    it("keeps the URL of a migrated legacy web block", () => {
        const migrated = { view: MoltentermBrowserView, url: "https://example.com", "web:zoom": 1.2 };
        expect(readBrowserState(migrated, "about:blank", () => "t1").tabs).toEqual([
            { id: "t1", url: "https://example.com" },
        ]);
    });

    it("leaves no creator of Wave's web view", () => {
        const offenders: string[] = [];
        for (const dir of ["frontend", "emain", "cmd", "pkg"]) {
            for (const file of sourceFiles(join(RepoRoot, dir))) {
                const rel = relative(RepoRoot, file).split("\\").join("/");
                if (AllowedWebViewFiles.has(rel)) {
                    continue;
                }
                const text = readFileSync(file, "utf8");
                if (LegacyWebCreation.some((re) => re.test(text))) {
                    offenders.push(rel);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
