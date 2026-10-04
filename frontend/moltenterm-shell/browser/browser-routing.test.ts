// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
    addTab,
    browserBlockDef,
    BrowserOpenKeyPrefix,
    consumeOpenRequestsMeta,
    MoltentermBrowserView,
    noteBrowserFocus,
    pickBrowserPanel,
    readBrowserState,
    readOpenRequests,
} from "./browser-model";

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

describe("links open as tabs of the current browser panel (#140)", () => {
    it("targets the most recently focused panel of the tab", () => {
        expect(pickBrowserPanel(["b1", "b2", "b3"], ["b2", "b3"])).toBe("b2");
    });

    it("skips panels that are gone", () => {
        expect(pickBrowserPanel(["b1", "b3"], ["gone", "b3", "b1"])).toBe("b3");
    });

    it("falls back to the tab's last panel when none was focused", () => {
        expect(pickBrowserPanel(["b1", "b2"], undefined)).toBe("b2");
        expect(pickBrowserPanel(["b1", "b2"], "b1")).toBe("b2");
    });

    it("creates a panel when the tab has none", () => {
        expect(pickBrowserPanel([], ["b1"])).toBeNull();
        expect(pickBrowserPanel(undefined, undefined)).toBeNull();
    });

    it("moves a focused panel to the front of the history", () => {
        expect(noteBrowserFocus(["b1", "b2"], "b2")).toEqual(["b2", "b1"]);
        expect(noteBrowserFocus(undefined, "b1")).toEqual(["b1"]);
    });

    it("writes nothing when the panel is already first", () => {
        expect(noteBrowserFocus(["b1", "b2"], "b1")).toBeNull();
    });

    it("keeps a short history", () => {
        const long = Array.from({ length: 10 }, (_, i) => `b${i}`);
        const next = noteBrowserFocus(long, "new");
        expect(next).toHaveLength(8);
        expect(next[0]).toBe("new");
    });

    it("reads the pages wsh queues for a panel in id order, ignoring other keys and empty entries", () => {
        const meta = {
            view: MoltentermBrowserView,
            url: "https://example.com/start",
            [BrowserOpenKeyPrefix + "0003"]: "https://example.com/c",
            [BrowserOpenKeyPrefix + "0001"]: "https://example.com/a",
            [BrowserOpenKeyPrefix + "0002"]: "",
            [BrowserOpenKeyPrefix]: "https://example.com/no-id",
        };
        expect(readOpenRequests(meta)).toEqual([
            { id: "0001", url: "https://example.com/a" },
            { id: "0003", url: "https://example.com/c" },
        ]);
        expect(readOpenRequests(null)).toEqual([]);
    });

    it("opens two requests that landed before the panel reacted, in order, and removes only those", () => {
        const meta: Record<string, any> = {
            [BrowserOpenKeyPrefix + "0001"]: "https://example.com/a",
            [BrowserOpenKeyPrefix + "0002"]: "https://example.com/b",
        };
        let state = readBrowserState({ url: "https://example.com/start" }, "about:blank", () => "t0");
        let n = 0;
        const requests = readOpenRequests(meta);
        for (const request of requests) {
            state = addTab(state, request.url, () => `t${++n}`);
        }
        expect(state.tabs.map((t) => t.url)).toEqual([
            "https://example.com/start",
            "https://example.com/a",
            "https://example.com/b",
        ]);
        expect(state.activeId).toBe("t2");
        expect(consumeOpenRequestsMeta(requests)).toEqual({
            [BrowserOpenKeyPrefix + "0001"]: null,
            [BrowserOpenKeyPrefix + "0002"]: null,
        });
    });
});
