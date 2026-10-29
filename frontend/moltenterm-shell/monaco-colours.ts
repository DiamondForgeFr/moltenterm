// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { colord } from "colord";

// The code editor on the Coulée tokens (FR-SHELL-120, #1340). Monaco takes hex colours, not CSS variables, so the
// tokens are read once when its theme is defined. Each entry names the token it takes; a token that does not
// resolve leaves Monaco's own colour rather than a guess.
type TokenRef = { token: string; alpha?: number };

const ColourTokens: Record<string, TokenRef> = {
    "editor.foreground": { token: "--mt-text-1" },
    "editorLineNumber.foreground": { token: "--mt-text-3" },
    "editorLineNumber.activeForeground": { token: "--mt-text-2" },
    // The caret is where one types, as in the Coulée terminal: the only orange in the editor.
    "editorCursor.foreground": { token: "--mt-action" },
    "editor.selectionBackground": { token: "--mt-text-1", alpha: 0.2 },
    "editor.inactiveSelectionBackground": { token: "--mt-line-2" },
    "editor.selectionHighlightBackground": { token: "--mt-line-2" },
    "editor.lineHighlightBorder": { token: "--mt-line-1" },
    "editorIndentGuide.background1": { token: "--mt-line-1" },
    "editorIndentGuide.activeBackground1": { token: "--mt-line-2" },
    "editorWhitespace.foreground": { token: "--mt-line-2" },
    "editorBracketMatch.background": { token: "--mt-line-1" },
    "editorBracketMatch.border": { token: "--mt-line-2" },
    "editorLink.activeForeground": { token: "--mt-action-text" },
    // Sticky scroll covers the code, so it is opaque; the minimap is a recessed strip.
    "editorStickyScroll.background": { token: "--mt-surface-1" },
    "editorStickyScrollHover.background": { token: "--mt-surface-2" },
    "minimap.background": { token: "--mt-surface-0" },
    "editorWidget.background": { token: "--mt-surface-3" },
    "editorWidget.foreground": { token: "--mt-text-1" },
    "editorWidget.border": { token: "--mt-line-2" },
    "editorSuggestWidget.background": { token: "--mt-surface-3" },
    "editorSuggestWidget.border": { token: "--mt-line-2" },
    "editorSuggestWidget.foreground": { token: "--mt-text-1" },
    "editorSuggestWidget.selectedBackground": { token: "--mt-text-1", alpha: 0.2 },
    "editorSuggestWidget.highlightForeground": { token: "--mt-text-1" },
    "editorHoverWidget.background": { token: "--mt-surface-3" },
    "editorHoverWidget.border": { token: "--mt-line-2" },
    "list.hoverBackground": { token: "--mt-text-1", alpha: 0.1 },
    "input.background": { token: "--mt-surface-2" },
    "input.foreground": { token: "--mt-text-1" },
    "input.border": { token: "--mt-line-control" },
    "scrollbarSlider.background": { token: "--mt-line-2" },
    "scrollbarSlider.hoverBackground": { token: "--mt-text-1", alpha: 0.2 },
    "scrollbarSlider.activeBackground": { token: "--mt-text-3" },
};

export function moltenMonacoColours(readToken: (name: string) => string): Record<string, string> {
    const colours: Record<string, string> = {};
    for (const [key, ref] of Object.entries(ColourTokens)) {
        const raw = readToken(ref.token)?.trim();
        if (!raw) {
            continue;
        }
        const parsed = colord(raw);
        if (!parsed.isValid()) {
            continue;
        }
        colours[key] = (ref.alpha == null ? parsed : parsed.alpha(parsed.alpha() * ref.alpha)).toHex();
    }
    return colours;
}

export function readDocumentToken(name: string): string {
    if (typeof document === "undefined") {
        return "";
    }
    return getComputedStyle(document.documentElement).getPropertyValue(name);
}
