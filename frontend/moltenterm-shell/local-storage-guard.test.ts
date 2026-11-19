// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// #1763: the app's pages run in the private session moltenterm-trusted-app-v1 (emain/authkey.ts, #864), kept in
// memory on purpose. Its localStorage is gone at every restart: a preference kept there jumps back. A preference goes
// to a setting (hidden in the Settings screen when its own control sets it) or to the meta of its object (workspace,
// block). Only state meant to last a moment, or a cache rebuilt on its own, may use localStorage, named here with why.
const Allowed: Record<string, string> = {
    "workspace-edit.ts": "a double-click handed from one tab view to the next across a switch, read within 500 ms",
    "sidebar/sidebar-switch.ts":
        "the switch's slide handed to the tab view that shows the new workspace, 2.5 s at most",
    "sidebar/sidebar-snapshot.ts": "captures of each workspace's sidebar for the swipe, retaken by each view at rest",
    "sidebar/workspace-sidebar.tsx": "the last workspace list, drawn by a new tab view until wavesrv answers",
    "legacy-storage.ts": "reads and drops what earlier versions kept, to move it into the settings or the meta",
    "reviews/reviews-order-store.ts": "the same move, for the Integration panel's sort and folds (#1758)",
    "boss/brokk-hub-store.ts":
        "what Brokk told and the Plus tard delay, handed from one view to the next within a run, so that a visit is not played again in each view (#2002); a restart starts them over",
};

const Root = "frontend/moltenterm-shell";

function sourceFiles(dir: string): string[] {
    const rtn: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            rtn.push(...sourceFiles(path));
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            rtn.push(path);
        }
    }
    return rtn;
}

// Comments may name it (to say why it is not used); only code counts.
function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function usersOfLocalStorage(): string[] {
    return sourceFiles(Root)
        .filter((path) => /\blocalStorage\b/.test(code(readFileSync(path, "utf8"))))
        .map((path) => relative(Root, path).split("\\").join("/"))
        .sort();
}

describe("localStorage in the MoltenTerm shell (#1763)", () => {
    it("is used only where it holds no preference", () => {
        const unexpected = usersOfLocalStorage().filter((path) => Allowed[path] == null);
        expect(
            unexpected,
            "localStorage is emptied at every restart: keep a preference in a setting or in its object's meta"
        ).toEqual([]);
    });

    it("lists no file that stopped using it", () => {
        const users = new Set(usersOfLocalStorage());
        expect(Object.keys(Allowed).filter((path) => !users.has(path))).toEqual([]);
    });

    it("sees a use in code, not in a comment", () => {
        expect(/\blocalStorage\b/.test(code('const v = window.localStorage.getItem("k");'))).toBe(true);
        expect(/\blocalStorage\b/.test(code("// kept in localStorage before\nconst v = 1;"))).toBe(false);
        expect(/\blocalStorage\b/.test(code("/* localStorage */ const v = 1;"))).toBe(false);
    });
});
