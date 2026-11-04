// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Every way into another panel is either a call to action inside a panel, which names its panel (openMoltentermView,
// openCicdTab and ReviewsModel.openReviews take an origin, #1844, FR-SHELL-139 AC13), or an app action started outside
// any panel, listed here with the rule it keeps (FR-SHELL-094). A new call that is neither fails this test: whoever adds
// it chooses, instead of the panel opening in a new view by default.

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const ShellDir = fileURLToPath(new URL(".", import.meta.url));

// Calls inside a panel, which must pass the panel they are in.
const InPanelFiles = [
    "browser/test-context.tsx",
    "mission/cicd-open.ts",
    "mission/cicd-panels.tsx",
    "mission/cicd-view.tsx",
    "mission/release-run-panel.tsx",
    "mission/release-setup.tsx",
    "mission/release-techdoc-link.tsx",
    "project/project-view.tsx",
    "reviews/reviews-card.tsx",
    "reviews/reviews-store.ts",
];

// App actions: the rail, the status bar, the sidebar, the command palette, the menus, a notification, a dialog opened
// from the sidebar. They never write into a pinned view.
const AppActionFiles = new Set([
    "menu/app-menu-commands.ts",
    "notifications-store.ts",
    "open-view.ts",
    "palette/palette-actions.ts",
    "project-sheet.tsx",
    "project/project-tab.ts",
    "rail-tools.tsx",
    "reviews/reviews-card-gesture.ts",
    "sessions/sessions-store.ts",
    "sidebar/top-field-open.tsx",
    "sidebar/workspace-sidebar.tsx",
    "status-bar.tsx",
]);

type Call = { name: string; args: number };

const Openers: { name: string; pattern: RegExp; originAt: number }[] = [
    { name: "openMoltentermView", pattern: /(?<!function\s)(?<![\w$.])openMoltentermView\(/g, originAt: 2 },
    { name: "openCicdTab", pattern: /(?<!function\s)(?<![\w$.])openCicdTab\(/g, originAt: 2 },
    { name: "openReviews", pattern: /\.openReviews\(/g, originAt: 4 },
];

function sourceFiles(dir: string): string[] {
    const rtn: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            rtn.push(...sourceFiles(path));
            continue;
        }
        if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
            rtn.push(path);
        }
    }
    return rtn;
}

// The arguments of the call whose "(" is at open, counted at the top level of its parentheses.
function argumentCount(text: string, open: number): number {
    let depth = 0;
    let args = 0;
    let started = false;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === "(" || ch === "[" || ch === "{") {
            depth++;
            continue;
        }
        if (ch === ")" || ch === "]" || ch === "}") {
            depth--;
            if (depth === 0) {
                return started ? args + 1 : 0;
            }
            continue;
        }
        if (ch === "," && depth === 1) {
            args++;
            continue;
        }
        if (depth >= 1 && !/\s/.test(ch)) {
            started = true;
        }
    }
    return 0;
}

function callsIn(text: string): Call[] {
    const rtn: Call[] = [];
    for (const opener of Openers) {
        for (const match of text.matchAll(opener.pattern)) {
            rtn.push({ name: opener.name, args: argumentCount(text, match.index + match[0].length - 1) });
        }
    }
    return rtn;
}

const OriginAt = new Map(Openers.map((o) => [o.name, o.originAt]));

function callsOf(file: string): Call[] {
    return callsIn(readFileSync(join(ShellDir, file), "utf8"));
}

describe("the argument counter", () => {
    it("counts the top-level arguments of a call, nested calls and objects aside", () => {
        expect(callsIn("openMoltentermView(View)")).toEqual([{ name: "openMoltentermView", args: 1 }]);
        expect(callsIn("openMoltentermView(View, origin(e))")).toEqual([{ name: "openMoltentermView", args: 2 }]);
        expect(callsIn("x.openReviews(dir, f(1, 2), undefined, { a: 1, b: 2 })")).toEqual([
            { name: "openReviews", args: 4 },
        ]);
        expect(callsIn("x.openReviews()")).toEqual([{ name: "openReviews", args: 0 }]);
    });

    it("leaves a definition, and a call with an opener's name as a property", () => {
        expect(callsIn("export async function openMoltentermView(requested: string, origin?: PanelOrigin) {}")).toEqual(
            []
        );
        expect(callsIn("model.openMoltentermView(x)")).toEqual([]);
    });
});

describe("calls into another panel (#1844)", () => {
    it("pass the panel they are in, from a call to action inside a panel", () => {
        const offenders: string[] = [];
        for (const file of InPanelFiles) {
            const text = readFileSync(join(ShellDir, file), "utf8");
            for (const call of callsIn(text)) {
                if (call.args < OriginAt.get(call.name)) {
                    offenders.push(`${file}: ${call.name}`);
                }
            }
            if (!/usePanelOrigin\(\)/.test(text) && !/origin\??: PanelOrigin/.test(text)) {
                offenders.push(`${file}: no origin of its own`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("are app actions, listed, wherever they pass no panel", () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(ShellDir)) {
            const rel = relative(ShellDir, file).split("\\").join("/");
            if (InPanelFiles.includes(rel) || AppActionFiles.has(rel)) {
                continue;
            }
            for (const call of callsOf(rel)) {
                offenders.push(`${rel}: ${call.name}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("keep no app action in the list that no longer calls", () => {
        const stale = [...AppActionFiles].filter((file) => file !== "open-view.ts" && callsOf(file).length === 0);
        expect(stale).toEqual([]);
    });
});
