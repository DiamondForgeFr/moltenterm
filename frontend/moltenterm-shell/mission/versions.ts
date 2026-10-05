// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the releases stand (FR-MC-002), ported from Notulia (src/lib/nextVersion.ts, devReleaseState.ts,
// releaseChannel.ts): the last public release, the last release candidate, and the version the next public release
// would carry, read from conventional commits (`type(#N): subject`). Deliberately not guessed: before the first
// public release the number is a decision, and commits that change nothing a user sees justify no release. The rules
// themselves live in ../releases/versions.ts, the twin of pkg/molten/versions.

import { BumpLevel, DefaultTagPrefix, lastPublic, lastRc, planRelease, VersionRules } from "../releases/versions";
import { RawCommit, RawTag, TreeData } from "./mission-model";

// A release candidate is a version with a suffix (v1.2.0-3), as in Notulia, read after the project's tag prefix (which
// may itself hold a dash, as release-1.2.0).
export function isPrereleaseTag(name: string, prefix: string = DefaultTagPrefix): boolean {
    return (name.startsWith(prefix) ? name.slice(prefix.length) : name).includes("-");
}

export type NextRelease = {
    version: string;
    how: "decision" | "derived" | "nothing";
    level?: BumpLevel;
    reason: string;
};

export type ReleaseState = {
    lastPublic: RawTag;
    lastRc: RawTag;
    next: NextRelease;
    // What waits on the trunk without being on the release branch yet.
    pending: { total: number; feat: RawCommit[]; fix: RawCommit[]; other: number };
};

const TypeRegex = /^([a-z]+)(\([^)]*\))?!?:/;

// A tag's version: the tag without the project's prefix (release-1.2.0-3 → 1.2.0-3).
export function tagVersion(tag: string, prefix: string = DefaultTagPrefix): string {
    return tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
}

// The numbering rules a project's history is read with (versions.tagprefix, versions.firstpublic).
export function treeRules(tree: Pick<TreeData, "tagPrefix" | "firstPublic">): VersionRules {
    return { tagprefix: tree?.tagPrefix || DefaultTagPrefix, firstpublic: tree?.firstPublic || "" };
}

export function releaseState(
    tags: readonly RawTag[],
    ahead: readonly RawCommit[],
    sincePublic: readonly RawCommit[],
    rules: VersionRules = {}
): ReleaseState {
    const names = tags.map((t) => t.name);
    const publicName = lastPublic(rules, names);
    const rcName = lastRc(rules, names);
    const plan = planRelease(
        rules,
        names,
        sincePublic.map((c) => ({ subject: c.subject })),
        "public"
    );
    const next: NextRelease =
        plan.how === "refused"
            ? { version: null, how: "nothing", reason: plan.reason }
            : {
                  version: plan.base,
                  how: plan.how === "derived" ? "derived" : "decision",
                  level: plan.level,
                  reason: plan.reason,
              };
    const typed = ahead.map((c) => ({ c, type: TypeRegex.exec(c.subject)?.[1] ?? "" }));
    const feat = typed.filter((t) => t.type === "feat").map((t) => t.c);
    const fix = typed.filter((t) => t.type === "fix").map((t) => t.c);
    return {
        lastPublic: tags.find((t) => t.name.trim() === publicName) ?? null,
        lastRc: tags.find((t) => t.name.trim() === rcName) ?? null,
        next,
        pending: { total: ahead.length, feat, fix, other: ahead.length - feat.length - fix.length },
    };
}

// A conventional subject as a person reads it: its ticket, then its words.
export function readableSubject(subject: string): { ticket: string; text: string } {
    const match = /^[a-z]+(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(subject ?? "");
    if (!match) {
        return { ticket: null, text: subject };
    }
    const ticket = /#(\d+)/.exec(match[1] ?? "")?.[1] ?? null;
    return { ticket, text: match[2] };
}
