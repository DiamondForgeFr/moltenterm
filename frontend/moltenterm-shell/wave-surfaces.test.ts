// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { moltenMonacoColours } from "./monaco-colours";

// Read from disk: vitest stubs stylesheet imports.
const shellCss = readFileSync(new URL("./moltenterm-shell.css", import.meta.url), "utf8");
const tokensCss = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const appDir = fileURLToPath(new URL("../app/", import.meta.url));

function waveFile(path: string): string {
    return readFileSync(join(appDir, path), "utf8");
}

// The token values as the page resolves them: tokens.css and the action tokens of moltenterm-shell.css.
function tokenValue(name: string): string {
    const re = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`);
    return (re.exec(tokensCss)?.[1] ?? re.exec(shellCss)?.[1] ?? "").trim();
}

// Theme "Coulée" step 7 (FR-SHELL-120, #1340).
describe("Wave surfaces on the Coulée tokens (FR-SHELL-120)", () => {
    it("points Wave's panel, inset and link colours at the tokens (AC-1)", () => {
        const neutrals = /\/\* Cast-iron neutrals[\s\S]*?:root,\n\.mt-light \[data-mt-dark-surface\] \{([^}]*)\}/.exec(
            shellCss
        )[1];
        const aliases: Record<string, string> = {
            "--block-bg-color": "--mt-surface-1",
            "--block-bg-solid-color": "--mt-surface-1",
            "--panel-bg-color": "--mt-surface-2",
            "--color-panel": "--mt-surface-2",
            "--link-color": "--mt-action-text",
            "--keybinding-color": "--mt-text-1",
            "--scrollbar-thumb-color": "--mt-line-2",
        };
        for (const [alias, target] of Object.entries(aliases)) {
            expect(neutrals, alias).toContain(`${alias}: var(${target});`);
        }
    });

    it("leaves no hard-coded colour or accent selection in the patched Wave rules (AC-1)", () => {
        const files = [
            "view/preview/directorypreview.scss",
            "modals/typeaheadmodal.scss",
            "modals/modal.scss",
            "element/markdown.scss",
        ];
        for (const file of files) {
            const css = waveFile(file);
            expect(css, file).not.toMatch(/rgba\(255, 255, 255/);
            expect(css, file).not.toMatch(/#212121|#32afff/i);
            expect(css, file).not.toMatch(/from var\(--accent-color\)/);
        }
        expect(waveFile("view/preview/directorypreview.scss")).not.toMatch(/from var\(--block-bg-color\) calc\(l/);
    });

    it("keeps the workspace colour off every Wave stylesheet (AC-3)", () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(path);
                    continue;
                }
                if (!/\.s?css$/.test(entry.name)) {
                    continue;
                }
                if (/--mt-place|--mt-accent\b/.test(readFileSync(path, "utf8"))) {
                    offenders.push(path);
                }
            }
        };
        walk(appDir);
        expect(offenders).toEqual([]);
    });
});

describe("code editor colours (FR-SHELL-120)", () => {
    const colours = moltenMonacoColours(tokenValue);

    it("reads the text, lines and widgets from the tokens", () => {
        expect(colours["editor.foreground"]).toBe(tokenValue("--mt-text-1"));
        expect(colours["editorLineNumber.foreground"]).toBe(tokenValue("--mt-text-3"));
        expect(colours["editorWidget.background"]).toBe(tokenValue("--mt-surface-3"));
        expect(colours["editorStickyScroll.background"]).toBe(tokenValue("--mt-surface-1"));
        expect(colours["input.border"]).toBe(tokenValue("--mt-line-control"));
        expect(colours["editor.lineHighlightBorder"]).toBe("#f2ede614");
    });

    it("draws the caret in the action colour and the selection in neutral text", () => {
        expect(colours["editorCursor.foreground"]).toBe(tokenValue("--mt-action"));
        expect(colours["editor.selectionBackground"]).toBe("#f2ede633");
    });

    it("gives Monaco only hex colours", () => {
        for (const [key, value] of Object.entries(colours)) {
            expect(value, key).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
        }
    });

    it("never takes the workspace colour", () => {
        const read: string[] = [];
        moltenMonacoColours((name) => {
            read.push(name);
            return tokenValue(name);
        });
        expect(read.length).toBeGreaterThan(0);
        expect(read.filter((name) => /place|accent/.test(name))).toEqual([]);
    });

    it("leaves Monaco's own colour when a token does not resolve", () => {
        const partial = moltenMonacoColours((name) => (name === "--mt-text-1" ? "#f2ede6" : ""));
        expect(partial["editor.foreground"]).toBe("#f2ede6");
        expect(partial["editorCursor.foreground"]).toBeUndefined();
        expect(moltenMonacoColours(() => "not a colour")).toEqual({});
    });
});
