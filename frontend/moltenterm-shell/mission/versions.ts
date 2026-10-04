// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the releases stand (FR-MC-002), ported from Notulia (src/lib/nextVersion.ts, devReleaseState.ts,
// releaseChannel.ts): the last public release, the last release candidate, and the version the next public release
// would carry, read from conventional commits (`type(#N): subject`). Deliberately not guessed: before the first
// public release the number is a decision, and commits that change nothing a user sees justify no release.

import { DefaultTagPrefix, isPrereleaseTag, RawCommit, RawTag } from "./tree";

export type BumpLevel = "major" | "minor" | "patch";

export type CommitInput = { subject: string; body?: string };

export type ParsedCommit = { type: string; breaking: boolean; subject: string };

export type BumpDecision = {
    level: BumpLevel;
    version: string;
    counts: Record<string, number>;
    breaking: string[];
    reason: string;
};

// Types whose presence alone is not a reason to release anything.
const SilentTypes = new Set(["chore", "ci", "test", "style", "docs", "build", "refactor"]);

const SubjectRegex = /^([a-z]+)(\([^)]*\))?(!)?:\s*(.+)$/;

export function parseCommit(commit: CommitInput): ParsedCommit {
    const m = SubjectRegex.exec(commit.subject.trim());
    if (!m) {
        return null;
    }
    const [, type, , bang, subject] = m;
    return { type, breaking: bang === "!" || /^BREAKING[ -]CHANGE:/m.test(commit.body ?? ""), subject };
}

export function parseVersion(version: string): [number, number, number] {
    const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
    if (!m) {
        throw new Error(`not a version: ${version}`);
    }
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function applyBump(version: string, level: BumpLevel): string {
    const [major, minor, patch] = parseVersion(version);
    if (level === "major") {
        return `${major + 1}.0.0`;
    }
    if (level === "minor") {
        return `${major}.${minor + 1}.0`;
    }
    return `${major}.${minor}.${patch + 1}`;
}

// null when the commits do not justify a release: a version made of chore and ci commits would be offered for nothing.
export function decideBump(lastVersion: string, commits: readonly CommitInput[]): BumpDecision {
    const counts: Record<string, number> = {};
    const breaking: string[] = [];
    let hasFeat = false;
    let hasUserFacing = false;
    let unconventional = 0;
    for (const commit of commits) {
        const parsed = parseCommit(commit);
        if (!parsed) {
            unconventional += 1;
            continue;
        }
        counts[parsed.type] = (counts[parsed.type] ?? 0) + 1;
        if (parsed.breaking) {
            breaking.push(parsed.subject);
        }
        if (parsed.type === "feat") {
            hasFeat = true;
        }
        if (!SilentTypes.has(parsed.type)) {
            hasUserFacing = true;
        }
    }
    if (unconventional > 0) {
        counts["(unconventional)"] = unconventional;
    }
    if (!hasUserFacing && breaking.length === 0) {
        return null;
    }
    const level: BumpLevel = breaking.length > 0 ? "major" : hasFeat ? "minor" : "patch";
    const reason =
        breaking.length > 0
            ? `${breaking.length} breaking change(s)`
            : hasFeat
              ? `${counts.feat} new feature(s)`
              : `${counts.fix ?? 0} fix(es), no new feature`;
    return { level, version: applyBump(lastVersion, level), counts, breaking, reason };
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

const byDateDesc = (a: RawTag, b: RawTag) => new Date(b.date).getTime() - new Date(a.date).getTime();
const TypeRegex = /^([a-z]+)(\([^)]*\))?!?:/;

// A tag's version: the tag without the project's prefix (release-1.2.0-3 → 1.2.0-3).
export function tagVersion(tag: string, prefix: string = DefaultTagPrefix): string {
    return tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
}

export function releaseState(
    tags: readonly RawTag[],
    ahead: readonly RawCommit[],
    sincePublic: readonly RawCommit[],
    prefix: string = DefaultTagPrefix
): ReleaseState {
    const releases = tags.filter((t) => t.name.startsWith(prefix));
    const lastPublic = releases.filter((t) => !isPrereleaseTag(t.name, prefix)).sort(byDateDesc)[0] ?? null;
    const lastRc = releases.filter((t) => isPrereleaseTag(t.name, prefix)).sort(byDateDesc)[0] ?? null;
    let next: NextRelease;
    if (!lastPublic) {
        const base = lastRc ? tagVersion(lastRc.name, prefix).split("-")[0] : "1.0.0";
        next = {
            version: base,
            how: "decision",
            reason: "First public release: a choice, not a calculation.",
        };
    } else {
        let decision: BumpDecision = null;
        try {
            decision = decideBump(
                tagVersion(lastPublic.name, prefix),
                sincePublic.map((c) => ({ subject: c.subject }))
            );
        } catch {
            decision = null;
        }
        next = decision
            ? { version: decision.version, how: "derived", level: decision.level, reason: decision.reason }
            : { version: null, how: "nothing", reason: `Nothing a user would see since ${lastPublic.name}.` };
    }
    const typed = ahead.map((c) => ({ c, type: TypeRegex.exec(c.subject)?.[1] ?? "" }));
    const feat = typed.filter((t) => t.type === "feat").map((t) => t.c);
    const fix = typed.filter((t) => t.type === "fix").map((t) => t.c);
    return {
        lastPublic,
        lastRc,
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

const ReleaseVersionRegex = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;

// The number of the next release candidate of a version: one more than the highest vX.Y.Z-N already tagged.
export function nextRc(base: string, existingTags: readonly string[], prefix: string = DefaultTagPrefix): number {
    parseVersion(base);
    let max = 0;
    for (const tag of existingTags) {
        const name = tag.trim();
        if (!name.startsWith(prefix)) {
            continue;
        }
        const m = ReleaseVersionRegex.exec(name.slice(prefix.length));
        if (!m || m[4] === undefined || `${m[1]}.${m[2]}.${m[3]}` !== base) {
            continue;
        }
        max = Math.max(max, Number(m[4]));
    }
    return max + 1;
}
