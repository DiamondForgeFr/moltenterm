// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Clean copy (FR-SHELL-017, DS-SHELL-018): the text an agent meant, from the lines its terminal UI drew. A pure
// function over the selected buffer lines, so every rule is tested on captured samples (clean-copy.test.ts).
//
// 1. Soft wraps (xterm's isWrapped) are joined.
// 2. The gutter glyphs of the agent's profile become spaces (columns stay aligned), frame-only lines are dropped and
//    the sides of a frame are removed.
// 3. Hard wraps are joined only when the agent's word wrap explains them: the line plus a space and the next line's
//    first word would overflow the agent's width, the next line keeps the same indentation and does not start a new
//    item. Anything else stays a line break: a missed join costs less than a sentence glued to a code line.
// 4. The common left padding is removed; indentation relative to the selection stays.

import { AgentCopyProfile } from "./agent-copy-profiles";

export type CopyLine = {
    // The buffer line from its first column (or from the selection start when `midLine`), right-trimmed except before
    // a soft wrap.
    text: string;
    // xterm's isWrapped: this line continues the previous one.
    wrapped: boolean;
    // The selection starts inside this line's text: its own indentation is not part of the copy.
    midLine?: boolean;
    // The column `text` starts at (only for a midLine first line).
    startCol?: number;
};

export type CopySelection = {
    lines: CopyLine[];
    cols: number;
};

type Logical = {
    text: string;
    // A gutter glyph started this line: it is a new message, a tool call or its result.
    item: boolean;
    midLine: boolean;
    // The columns of the last physical line, for the wrap rule.
    lastWidth: number;
    softWrapped: boolean;
    dropped: boolean;
    // The width the agent wrapped this line at, when a frame says it (else the terminal's).
    wrapWidth?: number;
};

const ListMarkerRegex = /^(?:[-*+]\s|\d+[.)]\s|>\s|[❯$#]\s)/;

// Columns a string takes: wide East Asian characters and emoji count two. Only the wrap rule needs it.
export function textColumns(s: string): number {
    let n = 0;
    for (const ch of s) {
        const cp = ch.codePointAt(0);
        n += isWide(cp) ? 2 : 1;
    }
    return n;
}

function isWide(cp: number): boolean {
    return (
        (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1faff) ||
        (cp >= 0x20000 && cp <= 0x3fffd)
    );
}

function indentOf(s: string): number {
    return s.length - s.trimStart().length;
}

function isBlank(s: string): boolean {
    return s.trim() === "";
}

function firstWord(s: string): string {
    return s.trim().split(/\s+/)[0] ?? "";
}

function lastWord(s: string): string {
    const words = s.trim().split(/\s+/);
    return words[words.length - 1] ?? "";
}

// Removes the profile's UI from one line: returns the line with gutters and frame sides turned into spaces, whether a
// gutter started it, and whether the line was only a frame.
export function stripLineChrome(
    line: string,
    profile: AgentCopyProfile
): { text: string; item: boolean; frameOnly: boolean; wrapWidth?: number } {
    const trimmed = line.trim();
    if (trimmed === "") {
        return { text: "", item: false, frameOnly: false };
    }
    const frames = profile.frames;
    if (frames.length > 0 && Array.from(trimmed).every((ch) => ch === " " || frames.includes(ch))) {
        const hasVertical = trimmed.includes("│") || trimmed.includes("┃");
        // A line of only "│" between two frame sides is an empty line of the box, not a frame edge.
        if (!hasVertical || /[─━╭╮╰╯┌┐└┘]/.test(trimmed)) {
            return { text: "", item: false, frameOnly: true };
        }
        return { text: "", item: false, frameOnly: false };
    }
    let text = line.trimEnd();
    let item = false;
    let wrapWidth: number = undefined;
    const indent = indentOf(text);
    const first = Array.from(text.slice(indent))[0];
    const afterFirst = text.slice(indent + first.length);
    // Claude Code puts a no-break space after ⎿.
    const followedBySpace = afterFirst === "" || /^\s/.test(afterFirst);
    if (followedBySpace && profile.gutters.includes(first)) {
        text = text.slice(0, indent) + " ".repeat(textColumns(first)) + afterFirst;
        item = true;
    } else if (followedBySpace && (first === "│" || first === "┃") && frames.includes(first)) {
        const sides = Array.from(afterFirst).filter((ch) => ch === first).length;
        if (sides === 0) {
            text = text.slice(0, indent) + " " + afterFirst;
        } else if (sides === 1 && afterFirst.trimEnd().endsWith(first)) {
            const body = afterFirst.trimEnd();
            // Text inside a frame wraps before the right side and the space that pads it.
            wrapWidth = textColumns(text.slice(0, indent + first.length) + body) - 2;
            text = text.slice(0, indent) + " " + body.slice(0, body.length - first.length).trimEnd();
        }
    }
    // The indentation comes out as plain spaces, whatever the TUI drew it with.
    text = text.trimEnd().replace(/^\s+/, (m) => " ".repeat(m.length));
    return { text, item, frameOnly: false, wrapWidth };
}

function toLogicalLines(sel: CopySelection, profile: AgentCopyProfile): Logical[] {
    const out: Logical[] = [];
    for (const line of sel.lines) {
        const last = out[out.length - 1];
        if (line.wrapped && last != null && !last.dropped) {
            last.text = last.text + line.text;
            last.lastWidth = textColumns(line.text.trimEnd());
            last.softWrapped = true;
            continue;
        }
        out.push({
            text: line.text,
            item: false,
            midLine: !!line.midLine || (line.wrapped && out.length === 0),
            lastWidth: (line.startCol ?? 0) + textColumns(line.text.trimEnd()),
            softWrapped: false,
            dropped: false,
        });
    }
    for (const l of out) {
        if (l.midLine) {
            l.text = l.text.trim();
            continue;
        }
        const stripped = stripLineChrome(l.text, profile);
        l.text = stripped.text;
        l.item = stripped.item;
        l.dropped = stripped.frameOnly;
        l.wrapWidth = stripped.wrapWidth;
        if (!l.softWrapped) {
            l.lastWidth = textColumns(l.text);
        }
    }
    return out.filter((l) => !l.dropped);
}

// Whether `next` continues `cur`, which the agent broke at its wrap width; and if so, whether with a space.
export function hardWrapJoin(
    cur: { text: string; lastWidth: number; contIndent: number; midLine: boolean; wrapWidth?: number },
    next: { text: string; item: boolean; wrapWidth?: number },
    termWidth: number
): "space" | "nospace" | null {
    if (isBlank(cur.text) || isBlank(next.text) || next.item) {
        return null;
    }
    if (cur.wrapWidth !== next.wrapWidth) {
        return null;
    }
    const width = cur.wrapWidth ?? termWidth;
    const nextIndent = indentOf(next.text);
    if (!cur.midLine && nextIndent !== cur.contIndent) {
        return null;
    }
    const body = next.text.trimStart();
    if (ListMarkerRegex.test(body)) {
        return null;
    }
    const word = firstWord(body);
    if (cur.lastWidth > width) {
        return null;
    }
    if (cur.lastWidth + 1 + textColumns(word) <= width) {
        return null;
    }
    if (cur.lastWidth === width) {
        const token = lastWord(cur.text) + word;
        if (nextIndent + textColumns(token) > width) {
            return "nospace";
        }
    }
    // A word wider than the line is broken across lines starting on the current one; after a short line it is
    // printed on a line of its own.
    const wordFillsNext = word === body && textColumns(next.text) >= width;
    if (nextIndent + textColumns(word) > width || wordFillsNext) {
        return null;
    }
    return "space";
}

export function cleanCopy(sel: CopySelection, profile: AgentCopyProfile): string {
    const logical = toLogicalLines(sel, profile);
    const width = Math.max(1, (sel.cols ?? 0) - profile.rightMargin);
    type Joined = {
        text: string;
        lastWidth: number;
        contIndent: number;
        midLine: boolean;
        soft: boolean;
        wrapWidth?: number;
    };
    const joined: Joined[] = [];
    for (const l of logical) {
        const cur = joined[joined.length - 1];
        if (profile.hardWraps && cur != null && !cur.soft && !l.softWrapped) {
            const how = hardWrapJoin(cur, l, width);
            if (how != null) {
                cur.text = cur.text + (how === "space" ? " " : "") + l.text.trimStart();
                cur.lastWidth = l.lastWidth;
                continue;
            }
        }
        joined.push({
            text: l.text,
            lastWidth: l.lastWidth,
            contIndent: indentOf(l.text),
            midLine: l.midLine,
            soft: l.softWrapped,
            wrapWidth: l.wrapWidth,
        });
    }
    let pad = Infinity;
    for (const j of joined) {
        if (j.midLine || isBlank(j.text)) {
            continue;
        }
        pad = Math.min(pad, indentOf(j.text));
    }
    if (pad === Infinity) {
        pad = 0;
    }
    const lines = joined.map((j) => (j.midLine ? j.text.trim() : j.text.slice(Math.min(pad, indentOf(j.text)))));
    while (lines.length > 0 && isBlank(lines[lines.length - 1])) {
        lines.pop();
    }
    while (lines.length > 0 && isBlank(lines[0])) {
        lines.shift();
    }
    return lines.map((l) => l.trimEnd()).join("\n");
}
