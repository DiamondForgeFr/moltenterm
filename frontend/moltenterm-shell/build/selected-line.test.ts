// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Selected = the rounded liseré (DS-SHELL-156, FR-SHELL-114, FR-SHELL-125 AC16, #2189): the selected one among siblings
// (a tab, a segment of a track, a section's entry, a view's tile or row) carries the carpet strip's inset line, defined
// once in moltenterm-shell.css. The guard reads the sources: a second definition of the line fails, so does a straight
// bar left on a selected element, and so does a listed surface that stops taking the shared line. An exception goes in
// the allow-list below with its reason.

import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";

const Root = resolve(__dirname, "../../..");
const ShellCss = "frontend/moltenterm-shell/moltenterm-shell.css";

function read(path: string): string {
    return readFileSync(join(Root, path), "utf8");
}

function sourceFiles(pattern: RegExp): string[] {
    const files: string[] = [];
    for (const rel of readdirSync(join(Root, "frontend"), { recursive: true }) as string[]) {
        const path = `frontend/${rel.split("\\").join("/")}`;
        if (!pattern.test(path) || /\.test\.tsx?$/.test(path) || path.includes("node_modules")) {
            continue;
        }
        files.push(path);
    }
    return files;
}

// The bodies of the rules that end on `selector` (alone or last of a list), joined.
function ruleBody(css: string, selector: string): string {
    const escaped = selector.replace(/[.()[\]>:*+~=",-]/g, "\\$&");
    return [...css.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, "g"))].map((m) => m[1]).join("\n");
}

// Surfaces that draw the selected state in CSS take the token itself: file → [selector, token it must hold].
export const CssSurfaces: [string, string, string][] = [
    ["frontend/moltenterm-shell/view360/radar.css", ".mt-strip-tab[data-focus]", "--mt-strip-line: var(--mt-selected-line);"],
    ["frontend/moltenterm-shell/sidebar/sidebar.css", ".mt-sb-selected", "var(--mt-selected-line),"],
    ["frontend/moltenterm-shell/sidebar/sidebar-agents.css", ".mt-sb-arow.is-on", "box-shadow: var(--mt-selected-line);"],
    ["frontend/moltenterm-shell/library/library.css", ".mt-lib-ni.is-on", "box-shadow: var(--mt-selected-line-action);"],
    ["frontend/moltenterm-shell/library/library.css", ".mt-lib-tile.is-on", "var(--mt-selected-line),"],
    ["frontend/moltenterm-shell/library/library.css", '.mt-lib-set[aria-current="true"]', "var(--mt-selected-line-action),"],
    ["frontend/moltenterm-shell/library/library.css", ".mt-lib-mrow.is-on", "box-shadow: var(--mt-selected-line);"],
    ["frontend/moltenterm-shell/view360/view360.css", ".mt-places-seg-choice.is-on", "box-shadow: var(--mt-selected-line-action);"],
    ["frontend/moltenterm-shell/tab-bar.css", ".tab.molten-tab.active .tab-inner", "box-shadow: var(--mt-selected-line);"],
    ["frontend/moltenterm-shell/command-panel/command-panel.css", ".molten-cmdpanel-segmented .is-active", "var(--mt-selected-line-action),"],
];

// Surfaces that draw it in a class string take the shared class: file → [classes, one of which it must hold].
export const ClassSurfaces: [string, string[]][] = [
    ["frontend/moltenterm-shell/sidebar/workspace-sidebar.tsx", ["mt-sb-selected", "mt-selected "]],
    ["frontend/moltenterm-shell/workspace-views/workspace-views-settings.tsx", ["mt-sb-selected"]],
    ["frontend/moltenterm-shell/settings/settings-screen.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/mission/cicd-view.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/mission/release-setup.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/mission/release-setup-analyse.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/mission/release-setup-update.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/mission/line-map.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/segmented-control.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/notification-settings.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/settings/settings-site-lists.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/review/review-view.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/review/review-comments-view.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/review/review-actions-view.tsx", ["mt-selected-action"]],
    ["frontend/moltenterm-shell/reviews/reviews-order.tsx", ["mt-selected-action"]],
    ["frontend/builder/builder-apppanel.tsx", ["mt-selected-action"]],
];

// A pseudo-element bar on a selected element, or a coloured bottom border: the straight marks the liseré replaced.
export const StraightBarPattern = /\b(?:before|after):(?:bg-accent|bg-\(--mt-(?:action|place)\))|\bborder-b-2\b[^"'`]*\bborder-accent\b/;

// file → why its bar is not the mark of a selected tab-like element.
export const StraightBarAllowed: Record<string, string> = {
    "frontend/moltenterm-shell/rail-tools.tsx":
        "the legacy rail's tool is a pressed toggle (aria-pressed: its flyout is open), not one of a set of siblings; the rail shows with the sidebar off",
};

const OwnInsetLine = /inset 0 -2px 0|inset_0_-2px_0|inset 0 calc\(-1 \* 2px\)/;

// Both guards below read every source of the frontend. They are read in one pass, here, while the file is collected:
// collection has no timeout, and a loaded machine stretches this I/O-bound scan past a test's 5 s (#2274). The tests only
// read the results.
function scanSources(): { ownLine: string[]; straightBar: string[] } {
    const ownLine: string[] = [];
    const straightBar: string[] = [];
    for (const path of sourceFiles(/\.(css|scss|ts|tsx)$/)) {
        const code = read(path);
        if (path !== ShellCss && OwnInsetLine.test(code)) {
            ownLine.push(path);
        }
        if (/\.tsx?$/.test(path) && StraightBarPattern.test(code) && StraightBarAllowed[path] == null) {
            straightBar.push(path);
        }
    }
    return { ownLine, straightBar };
}

const Scan = scanSources();

describe("the selected liseré is defined once (DS-SHELL-156)", () => {
    const shell = read(ShellCss);

    it("holds the two lines and the two classes in moltenterm-shell.css", () => {
        expect(shell).toContain("--mt-selected-line: inset 0 -2px 0 var(--mt-place);");
        expect(shell).toContain("--mt-selected-line-action: inset 0 -2px 0 var(--mt-action);");
        expect(ruleBody(shell, ":where(.mt-selected)")).toContain("box-shadow: var(--mt-selected-line);");
        expect(ruleBody(shell, ":where(.mt-selected-action)")).toContain("box-shadow: var(--mt-selected-line-action);");
    });

    it("is written nowhere else: no surface draws its own inset line along a bottom edge", () => {
        expect(Scan.ownLine).toEqual([]);
    });
});

describe("every selected tab-like surface takes the shared line", () => {
    it.each(CssSurfaces)("%s: %s", (file, selector, token) => {
        const body = ruleBody(read(file), selector);
        expect(body, `${selector} has no rule in ${file}`).not.toBe("");
        expect(body).toContain(token);
    });

    it.each(ClassSurfaces)("%s takes the shared class", (file, classes) => {
        const code = read(file);
        expect(classes.some((cls) => code.includes(cls)), `${file} lost ${classes.join(" or ")}`).toBe(true);
    });

    it("keeps the sidebar's tile in one place: the old bar under it is gone", () => {
        const sidebarCss = read("frontend/moltenterm-shell/sidebar/sidebar.css");
        const sidebar = read("frontend/moltenterm-shell/sidebar/workspace-sidebar.tsx");
        expect(sidebarCss).not.toContain("mt-sb-tile-place");
        expect(sidebar).not.toContain("mt-sb-tile-place");
    });
});

describe("no straight bar marks a selected tab-like element", () => {
    it("leaves no pseudo-element bar or coloured underline outside the allow-list", () => {
        expect(Scan.straightBar).toEqual([]);
    });

    it("keeps every allow-list entry honest: the file still holds the bar it excuses", () => {
        for (const path of Object.keys(StraightBarAllowed)) {
            expect(StraightBarPattern.test(read(path)), `${path} no longer needs its entry`).toBe(true);
        }
    });
});
