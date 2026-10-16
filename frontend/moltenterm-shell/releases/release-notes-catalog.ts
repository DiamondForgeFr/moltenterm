// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Every version's notes as the version history lists them (FR-REL-004, DS-REL-004), after Notulia's
// releaseNotesCatalog. The cut commits releases/<tag>.md with the version bump, before the tag, so a build carries its
// own notes and every earlier one: they are bundled at build time and read offline. The notes' format is #186's
// (UPSTREAM.md, "Release notes"): an optional front matter (`date`, `draft: true`), then markdown. Release candidates
// are grouped under the version they lead to, which Notulia does not do.

import type { MoltentermBuildChange } from "../build/build-info";
import { compareVersions, formatVersion, parseVersion, Version } from "./versions";

export type ReleaseNoteEntry = {
    // 1.0.0-3, without the tag prefix.
    version: string;
    // The markdown after the front matter.
    notes: string;
    // A release candidate (X.Y.Z-N), offered to testers only.
    prerelease: boolean;
    // The day of the cut (YYYY-MM-DD), "" when the notes do not say.
    date: string;
};

// One public version and the candidates that led to it, newest first.
export type ReleaseGroup = {
    // X.Y.Z
    base: string;
    // null while X.Y.Z is not released.
    release: ReleaseNoteEntry;
    candidates: ReleaseNoteEntry[];
};

const KeyLine = /^([a-z][a-z0-9]*)\s*:\s*(.*?)\s*$/;
const NotesFileRegex = /(?:^|\/)v([^/]+)\.md$/;

export type ParsedNotes = { front: Record<string, string>; body: string };

// The same reading as scripts/moltenterm-release-notes-body.mjs and pkg/molten/release/notes_format.go.
export function parseReleaseNotes(text: string): ParsedNotes {
    const normalized = (text ?? "").replace(/\r\n/g, "\n").replace(new RegExp("^" + String.fromCharCode(0xfeff)), "");
    if (!normalized.startsWith("---\n")) {
        return { front: {}, body: normalized };
    }
    const lines = normalized.slice(4).split("\n");
    const front: Record<string, string> = {};
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "---") {
            return {
                front,
                body: lines
                    .slice(i + 1)
                    .join("\n")
                    .replace(/^\n+/, ""),
            };
        }
        const m = KeyLine.exec(lines[i]);
        if (m) {
            front[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
    }
    return { front: {}, body: normalized };
}

export function isDraftNotes(front: Record<string, string>): boolean {
    return ["true", "yes", "1"].includes(String(front?.draft ?? "").toLowerCase());
}

// /releases/v1.0.0-3.md → 1.0.0-3; an engineering record, a translation or anything else → null.
export function versionOfNotesFile(path: string): string {
    const m = NotesFileRegex.exec(path ?? "");
    if (!m || m[1].endsWith(".internal")) {
        return null;
    }
    return parseVersion(m[1]) ? m[1] : null;
}

function versionOf(entry: { version: string }): Version {
    return parseVersion(entry.version);
}

// The bundled files as entries, newest first. Drafts and empty notes have no entry: a version with nothing to say yet
// is not listed rather than shown blank.
export function catalogFromFiles(files: Record<string, string>): ReleaseNoteEntry[] {
    const entries: ReleaseNoteEntry[] = [];
    for (const [path, raw] of Object.entries(files ?? {})) {
        const version = versionOfNotesFile(path);
        if (version == null) {
            continue;
        }
        const parsed = parseReleaseNotes(raw);
        const notes = parsed.body.trim();
        if (!notes || isDraftNotes(parsed.front)) {
            continue;
        }
        entries.push({ version, notes, prerelease: versionOf({ version }).rc !== 0, date: parsed.front.date ?? "" });
    }
    return entries.sort((a, b) => compareVersions(versionOf(b), versionOf(a)));
}

// A public build lists the public versions only: no candidate was offered to it. Any other build (a candidate, a gold,
// a local or dev build) lists everything.
export function visibleEntries(entries: readonly ReleaseNoteEntry[], channel: string): ReleaseNoteEntry[] {
    return channel === "public" ? entries.filter((e) => !e.prerelease) : [...entries];
}

export function groupReleases(entries: readonly ReleaseNoteEntry[]): ReleaseGroup[] {
    const groups = new Map<string, ReleaseGroup>();
    for (const entry of entries) {
        const v = versionOf(entry);
        if (v == null) {
            continue;
        }
        const base = formatVersion({ ...v, rc: 0 });
        let group = groups.get(base);
        if (group == null) {
            group = { base, release: null, candidates: [] };
            groups.set(base, group);
        }
        if (v.rc === 0) {
            group.release = entry;
        } else {
            group.candidates.push(entry);
        }
    }
    const list = [...groups.values()];
    for (const group of list) {
        group.candidates.sort((a, b) => compareVersions(versionOf(b), versionOf(a)));
    }
    return list.sort((a, b) => compareVersions(parseVersion(b.base), parseVersion(a.base)));
}

// The entries in the order the list shows them: each version, then its candidates.
export function orderedEntries(groups: readonly ReleaseGroup[]): ReleaseNoteEntry[] {
    const rtn: ReleaseNoteEntry[] = [];
    for (const group of groups) {
        if (group.release) {
            rtn.push(group.release);
        }
        rtn.push(...group.candidates);
    }
    return rtn;
}

export function entryFor(entries: readonly ReleaseNoteEntry[], version: string): ReleaseNoteEntry {
    const wanted = (version ?? "").trim().replace(/^v/, "");
    return entries.find((e) => e.version === wanted);
}

export type BuildChangeGroups = {
    features: MoltentermBuildChange[];
    fixes: MoltentermBuildChange[];
    other: MoltentermBuildChange[];
    // Counted, not listed: a tester reads what changed for them, not the tooling around it (#753).
    internal: number;
};

const TypeRegex = /^([a-z]+)(\([^)]*\))?!?:/;
const InternalTypes = new Set(["test", "chore", "ci", "build", "refactor", "docs", "style"]);

// "This build": its commits since the last release, as New (feat), Fixed (fix, perf, revert) and Other (untyped
// subjects); test, tooling and docs commits are only counted.
export function groupBuildChanges(changes: readonly MoltentermBuildChange[]): BuildChangeGroups {
    const groups: BuildChangeGroups = { features: [], fixes: [], other: [], internal: 0 };
    for (const change of changes ?? []) {
        const type = TypeRegex.exec(change.subject ?? "")?.[1];
        if (type === "feat") {
            groups.features.push(change);
        } else if (type === "fix" || type === "perf" || type === "revert") {
            groups.fixes.push(change);
        } else if (InternalTypes.has(type)) {
            groups.internal++;
        } else {
            groups.other.push(change);
        }
    }
    return groups;
}
