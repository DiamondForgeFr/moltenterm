// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// File references in terminal text (FR-SHELL-017): path, path:line and path:line:col, relative or absolute. The
// matcher is generous (any word with a slash or an extension); only references whose file exists become links,
// which file-stat-cache.ts decides.

export type FileRef = {
    // Index in the text of the first and past-the-last character of the reference, `:line:col` included.
    start: number;
    end: number;
    path: string;
    line?: number;
    col?: number;
};

// A path: an optional ~/ ./ ../ or / prefix, then path characters. The lookbehind keeps URL paths and words glued to
// other text out; the `:line:col` suffix is optional.
const FileRefRegex = /(?<![\w/.:@~%+\-?&#])((?:~\/|\.{1,2}\/|\/)?[\w.@+-][\w.@+/-]*)(?::(\d+)(?::(\d+))?)?/g;

const TrailingPunctuation = /[.,;:!?)\]}'"`-]+$/;

const MaxPathLength = 1024;

function looksLikePath(path: string): boolean {
    if (path.length < 2 || path.length > MaxPathLength) {
        return false;
    }
    if (path.includes("//")) {
        return false;
    }
    const segments = path.split("/").filter((s) => s !== "");
    if (segments.length === 0) {
        return false;
    }
    const base = segments[segments.length - 1];
    if (path.includes("/")) {
        // a/b, src/, ~/x: something other than dots and digits.
        return /[A-Za-z_]/.test(path.replace(/^~/, ""));
    }
    // A bare name needs an extension that starts with a letter: file.ts, README.md, .env (not 1.5 or e.g).
    return /^[\w@+-]*\.[A-Za-z][\w-]*$/.test(base) && base !== "e.g" && base !== "i.e";
}

export function findFileRefs(text: string): FileRef[] {
    const refs: FileRef[] = [];
    if (!text) {
        return refs;
    }
    FileRefRegex.lastIndex = 0;
    for (let m = FileRefRegex.exec(text); m != null; m = FileRefRegex.exec(text)) {
        const start = m.index;
        // A scheme (https://...) is the web-links addon's.
        if (text.slice(start + m[1].length, start + m[1].length + 3) === "://") {
            continue;
        }
        let path = m[1];
        let line = m[2] != null ? Number(m[2]) : undefined;
        let col = m[3] != null ? Number(m[3]) : undefined;
        let end = start + m[0].length;
        if (line == null) {
            const trimmed = path.replace(TrailingPunctuation, "");
            end -= path.length - trimmed.length;
            path = trimmed;
        }
        if (path.endsWith("/") && path.length > 1) {
            // A folder is not opened at a line.
            line = undefined;
            col = undefined;
        }
        if (!looksLikePath(path)) {
            continue;
        }
        refs.push({ start, end, path, line: line || undefined, col: col || undefined });
    }
    return refs;
}

// The selection as one reference ("src/a.ts:12"), for the selection toolbar's Open.
export function parseFileRef(text: string): FileRef {
    const t = (text ?? "").trim();
    if (t === "" || /\s/.test(t)) {
        return null;
    }
    const refs = findFileRefs(t);
    if (refs.length !== 1 || refs[0].start !== 0) {
        return null;
    }
    return refs[0];
}
