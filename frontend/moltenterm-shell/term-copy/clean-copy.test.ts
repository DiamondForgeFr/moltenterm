// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { agentCopyProfile, GenericCopyProfile } from "./agent-copy-profiles";
import { cleanCopy, CopyLine, hardWrapJoin, stripLineChrome } from "./clean-copy";

// Buffer lines captured in a 107-column MoltenTerm terminal (xterm buffer, right-trimmed):
// - FakeAgent107: a script printing Claude Code-like output (⏺ messages, ⎿ results, code, a framed tip, a list),
//   word-wrapped like Ink does;
// - ClaudeCode107: Claude Code 2.1.289 itself, a shell-mode command (⎿ output with a hard-broken path) and its reply;
// - ClaudeHelp107: Claude Code's /help panel (padded dialog and a three-column table).
const FakeAgent107 = [
    "⏺ I updated the clean copy rules so that the selection toolbar and the context menu share the same helper,",
    "  and the hard-wrap heuristic now only joins lines when the next word would not have fitted on the previous",
    "  line.",
    "",
    "⏺ Bash(npx vitest run frontend/moltenterm-shell/term-copy)",
    "  ⎿  Test Files  3 passed (3) and every scenario of the clean copy suite ran against the captured samples",
    "     without a single failure",
    "     Tests  21 passed (21)",
    "",
    "⏺ Here is the function, see src/app/model.ts:12:3 for the call site:",
    "",
    "  function joinLines(a, b) {",
    "      if (!a) {",
    "          return b;",
    "      }",
    "      return a + \" \" + b;",
    "  }",
    "",
    "⏺ A long path that the TUI breaks:",
    "  /Users/someone/Documents/Projects/a-very-long-folder-name/another-long-folder/src/components/file.tsx",
    "",
    "  ╭───────────────────────────────────────────────────────────────────────────────────────────────────────╮",
    "  │ Tip: boxed text from the agent, wrapped inside its frame, should come out as one paragraph without    │",
    "  │ the frame sides.                                                                                      │",
    "  ╰───────────────────────────────────────────────────────────────────────────────────────────────────────╯",
    "",
    "  - a list item",
    "  - another list item",
];

const ClaudeCode107 = [
    "! python3 -c \"print(('alpha beta gamma delta '*14).strip()); print('/Users/someone/'+'x'*130+'/end.txt')\"  ",
    "  ⎿  alpha beta gamma delta alpha beta gamma delta alpha beta gamma delta alpha beta gamma delta alpha beta",
    "     gamma delta alpha beta gamma delta alpha beta gamma delta alpha beta gamma delta alpha beta gamma",
    "     delta alpha beta gamma delta alpha beta gamma delta alpha beta gamma delta alpha beta gamma delta",
    "     alpha beta gamma delta",
    "     /Users/someone/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "     xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/end.txt",
    "",
    "⏺ That command printed two long lines: \"alpha beta gamma delta\" repeated 14 times, and a 147-character path",
    "  with 130 xs, ending in /end.txt. It looks like a check of how long lines wrap or truncate in the",
    "  terminal. Nothing went to stderr.",
    "",
    "  What would you like to do with this, if anything?",
];

const ClaudeHelp107 = [
    "   Claude understands your codebase, makes edits with your permission, and executes commands — right",
    "   from your terminal.",
    "",
    "   New here? Run /powerup to learn the features most people miss.",
    "",
    "   Shortcuts",
    "   ! for shell mode          double tap esc to clear input        ctrl + shift + _ to undo",
    "   / for commands            shift + tab to auto-accept edits     ctrl + z to suspend",
    "   @ for file paths          ctrl + o for verbose output          ctrl + v to paste images",
    "   /btw for side question    ctrl + t to toggle tasks             opt + p to switch model",
    "                             backslash (\\) + return (⏎) for       ctrl + s to stash prompt",
    "                             newline                              ctrl + g to edit in $EDITOR",
    "                                                                  /keybindings to customize",
];

const Claude = agentCopyProfile("claude");

function sel(lines: string[], cols = 107, wrapped: number[] = []): { lines: CopyLine[]; cols: number } {
    return { lines: lines.map((text, i) => ({ text, wrapped: wrapped.includes(i) })), cols };
}

describe("cleanCopy on a Claude Code-like transcript", () => {
    it("rejoins the TUI's wrapped paragraphs and drops gutters and frames, keeping code indentation", () => {
        expect(cleanCopy(sel(FakeAgent107), Claude)).toBe(
            [
                "I updated the clean copy rules so that the selection toolbar and the context menu share the same helper, and the hard-wrap heuristic now only joins lines when the next word would not have fitted on the previous line.",
                "",
                "Bash(npx vitest run frontend/moltenterm-shell/term-copy)",
                "   Test Files  3 passed (3) and every scenario of the clean copy suite ran against the captured samples without a single failure",
                "   Tests  21 passed (21)",
                "",
                "Here is the function, see src/app/model.ts:12:3 for the call site:",
                "",
                "function joinLines(a, b) {",
                "    if (!a) {",
                "        return b;",
                "    }",
                '    return a + " " + b;',
                "}",
                "",
                "A long path that the TUI breaks: /Users/someone/Documents/Projects/a-very-long-folder-name/another-long-folder/src/components/file.tsx",
                "",
                "  Tip: boxed text from the agent, wrapped inside its frame, should come out as one paragraph without the frame sides.",
                "",
                "- a list item",
                "- another list item",
            ].join("\n")
        );
    });

    it("copies a code block alone with its own indentation", () => {
        expect(cleanCopy(sel(FakeAgent107.slice(11, 17)), Claude)).toBe(
            'function joinLines(a, b) {\n    if (!a) {\n        return b;\n    }\n    return a + " " + b;\n}'
        );
    });

    it("only removes the padding without an agent profile", () => {
        expect(cleanCopy(sel(FakeAgent107.slice(0, 3)), GenericCopyProfile)).toBe(FakeAgent107.slice(0, 3).join("\n"));
    });
});

describe("cleanCopy on Claude Code's own rendering", () => {
    it("rejoins tool output and replies, and a path the TUI hard-broke", () => {
        expect(cleanCopy(sel(ClaudeCode107.slice(1)), Claude).split("\n")).toEqual(
            [
                "   " + Array(14).fill("alpha beta gamma delta").join(" "),
                "   /Users/someone/" + "x".repeat(130) + "/end.txt",
                "",
                'That command printed two long lines: "alpha beta gamma delta" repeated 14 times, and a 147-character path with 130 xs, ending in /end.txt. It looks like a check of how long lines wrap or truncate in the terminal. Nothing went to stderr.',
                "",
                "What would you like to do with this, if anything?",
            ]
        );
    });

    it("keeps a table's columns and does not join across them", () => {
        const out = cleanCopy(sel(ClaudeHelp107.slice(5)), Claude);
        expect(out.split("\n")).toEqual(ClaudeHelp107.slice(5).map((l) => l.slice(3)));
    });

    it("misses the join of a padded dialog rather than guessing its margin", () => {
        expect(cleanCopy(sel(ClaudeHelp107.slice(0, 2)), Claude)).toBe(
            "Claude understands your codebase, makes edits with your permission, and executes commands — right\nfrom your terminal."
        );
    });
});

describe("cleanCopy selection shapes", () => {
    it("joins soft wraps (isWrapped) whatever the profile", () => {
        expect(cleanCopy(sel(["  $ echo aaaa", "bbbb", "  next"], 13, [1]), GenericCopyProfile)).toBe(
            "$ echo aaaabbbb\nnext"
        );
    });

    it("drops the indentation of a selection that starts inside a line", () => {
        const s = {
            lines: [
                { text: "copy rules so that", wrapped: false, midLine: true, startCol: 20 },
                { text: "  and more", wrapped: false },
            ],
            cols: 107,
        };
        expect(cleanCopy(s, Claude)).toBe("copy rules so that\nand more");
    });

    it("does not join a line to the next item", () => {
        const words = Array(20).fill("word").join(" ");
        expect(cleanCopy(sel(["⏺ " + words, "⏺ Next message"], 102), Claude)).toBe(words + "\nNext message");
    });

    it("does not join a full line to a list item or a different indentation", () => {
        const full = "  " + "x".repeat(40) + " " + "y".repeat(30);
        expect(cleanCopy(sel([full, "  - item"], 73), Claude)).toBe(full.trim() + "\n- item");
        expect(cleanCopy(sel([full, "      deeper"], 73), Claude)).toBe(full.trim() + "\n    deeper");
    });
});

describe("hardWrapJoin", () => {
    const cur = (text: string) => ({ text, lastWidth: text.length, contIndent: 2, midLine: false });
    const next = (text: string) => ({ text, item: false });

    it("joins when the next word could not fit", () => {
        expect(hardWrapJoin(cur("  " + "a".repeat(15)), next("  bbbb"), 20)).toBe("space");
        expect(hardWrapJoin(cur("  " + "a".repeat(12)), next("  bbbb"), 20)).toBeNull();
    });

    it("joins a hard-broken word without a space", () => {
        expect(hardWrapJoin(cur("  " + "a".repeat(18)), next("  bbbbbbbbbbbbbbbbb"), 20)).toBe("nospace");
    });

    it("keeps a word longer than the line on its own line after a short one", () => {
        expect(hardWrapJoin(cur("  short"), next("  " + "z".repeat(30)), 20)).toBeNull();
    });
});

describe("stripLineChrome", () => {
    it("turns gutters into spaces and keeps columns", () => {
        expect(stripLineChrome("  ⎿  result", Claude)).toMatchObject({ text: "     result", item: true });
        // Claude Code draws "⎿" + no-break space.
        expect(stripLineChrome("  ⎿  result", Claude)).toMatchObject({ text: "     result", item: true });
    });

    it("keeps glyphs that are text", () => {
        expect(stripLineChrome("  ⏺not-a-gutter", Claude).text).toBe("  ⏺not-a-gutter");
    });

    it("drops frame edges and the sides of a box, not a table row", () => {
        expect(stripLineChrome("  ╭──────╮", Claude).frameOnly).toBe(true);
        expect(stripLineChrome("  │ tip  │", Claude)).toMatchObject({ text: "    tip", wrapWidth: 8 });
        expect(stripLineChrome("│ a │ b │", Claude).text).toBe("│ a │ b │");
        expect(stripLineChrome("├───┼───┤", Claude).frameOnly).toBe(false);
    });
});
