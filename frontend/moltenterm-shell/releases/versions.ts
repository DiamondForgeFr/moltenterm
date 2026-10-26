// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A project's release numbering (FR-REL-001, DS-REL-001), ported from Notulia (src/lib/releaseChannel.ts,
// src/lib/nextVersion.ts). The twin of pkg/molten/versions: both run pkg/molten/versions/testdata/vectors.json, so the
// Release menu never proposes a number the backend would refuse.

// The highest candidate number a Windows MSI ProductVersion can hold (Notulia's MAX_PRERELEASE).
export const MaxRc = 65535;

export const DefaultTagPrefix = "v";
export const DefaultFirstPublic = "1.0.0";

// rclabel: "rc" for an X.Y.Z-rc.N candidate, absent for X.Y.Z-N; meaningless on a public release.
export type Version = { major: number; minor: number; patch: number; rc: number; rclabel?: string };

export type ReleaseChannel = "rc" | "public";

// must match the RcFormat constants in pkg/molten/versions/tags.go
export type RcFormat = "numeric" | "rcdot";

// must match Rules in pkg/molten/versions/tags.go
export type VersionRules = { tagprefix?: string; firstpublic?: string; rcformat?: string };

// No leading zeros, and a candidate number from 1: X.Y.Z-0 is never a release. Both candidate forms are always read,
// whatever versions.rcformat says: a project that switches keeps its old tags.
const VersionRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(rc)\.)?([1-9]\d*))?$/;

// null for anything but X.Y.Z, X.Y.Z-N or X.Y.Z-rc.N (1 ≤ N ≤ MaxRc).
export function parseVersion(s: string): Version {
    const m = VersionRegex.exec(s ?? "");
    if (!m) {
        return null;
    }
    const rc = m[5] ? Number(m[5]) : 0;
    if (rc > MaxRc) {
        return null;
    }
    const v: Version = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), rc };
    if (m[4]) {
        v.rclabel = m[4];
    }
    return v;
}

// A public version, X.Y.Z; null otherwise.
export function parseBase(s: string): Version {
    const v = parseVersion(s);
    return v && v.rc === 0 ? v : null;
}

export function isBaseVersion(s: string): boolean {
    return parseBase(s) != null;
}

export function formatVersion(v: Version): string {
    const base = `${v.major}.${v.minor}.${v.patch}`;
    if (v.rc === 0) {
        return base;
    }
    return v.rclabel ? `${base}-${v.rclabel}.${v.rc}` : `${base}-${v.rc}`;
}

function sign(n: number): number {
    return n < 0 ? -1 : n > 0 ? 1 : 0;
}

// Semver order: 1.0.0-1 < 1.0.0-2 < 1.0.0-10 < 1.0.0-rc.1 < 1.0.0 < 1.0.1-1. A numeric pre-release sorts before an
// alphanumeric one, so every X.Y.Z-N comes before every X.Y.Z-rc.N, the order npm and the updaters apply.
export function compareVersions(a: Version, b: Version): number {
    const head = sign(a.major - b.major) || sign(a.minor - b.minor) || sign(a.patch - b.patch);
    if (head !== 0) {
        return head;
    }
    if (a.rc === 0 || b.rc === 0) {
        return sign(b.rc - a.rc);
    }
    const la = a.rclabel ?? "";
    const lb = b.rclabel ?? "";
    if (la !== lb) {
        return la === "" ? -1 : lb === "" ? 1 : la < lb ? -1 : 1;
    }
    return sign(a.rc - b.rc);
}

function prefixOf(rules: VersionRules): string {
    return rules?.tagprefix || DefaultTagPrefix;
}

function floorOf(rules: VersionRules): Version {
    const base = parseBase(rules?.firstpublic ?? "");
    return base ? { ...base, rc: 1 } : null;
}

export function tagOf(rules: VersionRules, v: Version): string {
    return prefixOf(rules) + formatVersion(v);
}

// A tag read as one of the project's releases: the prefix, a strict version, and not below versions.firstpublic's
// first candidate (a fork's upstream tags are not its releases). null otherwise.
export function releaseOf(rules: VersionRules, tag: string): Version {
    const name = (tag ?? "").trim();
    const prefix = prefixOf(rules);
    if (!name.startsWith(prefix)) {
        return null;
    }
    const v = parseVersion(name.slice(prefix.length));
    if (!v) {
        return null;
    }
    const floor = floorOf(rules);
    return floor && compareVersions(v, floor) < 0 ? null : v;
}

// "rc", "public", or null for a tag that is not one of the project's releases.
export function channelOfTag(rules: VersionRules, tag: string): ReleaseChannel {
    const v = releaseOf(rules, tag);
    if (!v) {
        return null;
    }
    return v.rc === 0 ? "public" : "rc";
}

function highest(rules: VersionRules, tags: readonly string[], rc: boolean): string {
    let best: string = null;
    let bestVersion: Version = null;
    for (const tag of tags) {
        const v = releaseOf(rules, tag);
        if (!v || (v.rc !== 0) !== rc) {
            continue;
        }
        if (best == null || compareVersions(v, bestVersion) > 0) {
            best = tag.trim();
            bestVersion = v;
        }
    }
    return best;
}

// The highest public release in semver order (not by date), or null.
export function lastPublic(rules: VersionRules, tags: readonly string[]): string {
    return highest(rules, tags, false);
}

export function lastRc(rules: VersionRules, tags: readonly string[]): string {
    return highest(rules, tags, true);
}

// The next free candidate number of a public version: one more than the highest candidate number already tagged, in
// either form (after X.Y.Z-2, X.Y.Z-rc.3).
export function nextRc(rules: VersionRules, base: Version, tags: readonly string[]): number {
    let max = 0;
    for (const tag of tags) {
        const v = releaseOf(rules, tag);
        if (!v || v.rc === 0 || compareVersions({ ...v, rc: 0 }, { ...base, rc: 0 }) !== 0) {
            continue;
        }
        max = Math.max(max, v.rc);
    }
    return max + 1;
}

// The next release candidate of a public version, in the project's format. A version that already has an X.Y.Z-rc.N
// candidate keeps that form until it is public: an X.Y.Z-N after it would sort below it.
export function nextCandidate(rules: VersionRules, base: Version, tags: readonly string[]): Version {
    let label = rules?.rcformat === "rcdot" ? "rc" : "";
    for (const tag of tags) {
        const v = releaseOf(rules, tag);
        if (v && v.rc !== 0 && v.rclabel && compareVersions({ ...v, rc: 0 }, { ...base, rc: 0 }) === 0) {
            label = v.rclabel;
        }
    }
    const rtn: Version = { major: base.major, minor: base.minor, patch: base.patch, rc: nextRc(rules, base, tags) };
    if (label) {
        rtn.rclabel = label;
    }
    return rtn;
}

// How the project's candidates read, for a message: X.Y.Z-N or X.Y.Z-rc.N.
export function rcPattern(rules: VersionRules): string {
    return rules?.rcformat === "rcdot" ? "X.Y.Z-rc.N" : "X.Y.Z-N";
}

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

export const UnconventionalCount = "(unconventional)";

// null for a subject outside the convention: counted, never guessed at.
export function parseCommit(commit: CommitInput): ParsedCommit {
    const m = SubjectRegex.exec(commit.subject.trim());
    if (!m) {
        return null;
    }
    const [, type, , bang, subject] = m;
    return { type, breaking: bang === "!" || /^BREAKING[ -]CHANGE:/m.test(commit.body ?? ""), subject };
}

export function applyBump(v: Version, level: BumpLevel): Version {
    if (level === "major") {
        return { major: v.major + 1, minor: 0, patch: 0, rc: 0 };
    }
    if (level === "minor") {
        return { major: v.major, minor: v.minor + 1, patch: 0, rc: 0 };
    }
    return { major: v.major, minor: v.minor, patch: v.patch + 1, rc: 0 };
}

// null when the commits do not justify a release: a version made of chore and ci commits would be offered for nothing.
export function decideBump(last: Version, commits: readonly CommitInput[]): BumpDecision {
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
        hasFeat = hasFeat || parsed.type === "feat";
        hasUserFacing = hasUserFacing || !SilentTypes.has(parsed.type);
    }
    if (unconventional > 0) {
        counts[UnconventionalCount] = unconventional;
    }
    if (!hasUserFacing && breaking.length === 0) {
        return null;
    }
    let level: BumpLevel = "patch";
    let reason = `${counts.fix ?? 0} fix(es), no new feature`;
    if (hasFeat) {
        level = "minor";
        reason = `${counts.feat} new feature(s)`;
    }
    if (breaking.length > 0) {
        level = "major";
        reason = `${breaking.length} breaking change(s)`;
    }
    return { level, version: formatVersion(applyBump({ ...last, rc: 0 }, level)), counts, breaking, reason };
}

export type PlanHow = "decision" | "derived" | "override" | "refused";

// must match PlanResult in pkg/molten/versions/plan.go
export type PlanResult = {
    channel: string;
    how: PlanHow;
    base?: string;
    version?: string;
    tag?: string;
    level?: BumpLevel;
    reason: string;
    derived?: string;
    lastpublic?: string;
};

function refused(channel: string, lastPublicTag: string, reason: string): PlanResult {
    const rtn: PlanResult = { channel, how: "refused", reason };
    if (lastPublicTag) {
        rtn.lastpublic = lastPublicTag;
    }
    return rtn;
}

function firstPublicProposal(rules: VersionRules, tags: readonly string[]): Version {
    const declared = parseBase(rules?.firstpublic ?? "");
    if (declared) {
        return declared;
    }
    const rc = releaseOf(rules, lastRc(rules, tags));
    return rc ? { ...rc, rc: 0 } : parseBase(DefaultFirstPublic);
}

// The version and tag the next release of a channel carries. commits are those since the last public release.
// override, when given, is the public version to release instead: above the last public release, and taken even when
// the commits justify no release.
export function planRelease(
    rules: VersionRules,
    tags: readonly string[],
    commits: readonly CommitInput[],
    channel: string,
    override = ""
): PlanResult {
    const lastPublicTag = lastPublic(rules, tags);
    if (channel !== "rc" && channel !== "public") {
        return refused(channel, lastPublicTag, `Not a release channel: ${JSON.stringify(channel)}.`);
    }
    let base: Version = null;
    const rtn: PlanResult = { channel, how: "decision", reason: "" };
    if (lastPublicTag) {
        rtn.lastpublic = lastPublicTag;
    }
    let derivedOk = true;
    if (!lastPublicTag) {
        base = firstPublicProposal(rules, tags);
        rtn.reason = "First public release: a choice, not a calculation.";
    } else {
        const decision = decideBump(releaseOf(rules, lastPublicTag), commits);
        if (decision == null) {
            derivedOk = false;
            rtn.how = "refused";
            rtn.reason = `Nothing a user would see since ${lastPublicTag} (only chore, ci, docs, test, style, build or refactor commits).`;
        } else {
            base = parseBase(decision.version);
            rtn.how = "derived";
            rtn.level = decision.level;
            rtn.reason = decision.reason;
        }
    }
    if (override) {
        const chosen = parseBase(override.trim());
        if (!chosen) {
            return refused(channel, lastPublicTag, `${override} is not a public version (X.Y.Z).`);
        }
        const last = releaseOf(rules, lastPublicTag);
        if (last && compareVersions(chosen, last) <= 0) {
            return refused(
                channel,
                lastPublicTag,
                `${formatVersion(chosen)} is not above the last public release, ${lastPublicTag}.`
            );
        }
        if (!releaseOf(rules, tagOf(rules, { ...chosen, rc: 1 }))) {
            return refused(
                channel,
                lastPublicTag,
                `${formatVersion(chosen)} is below versions.firstpublic (${rules?.firstpublic ?? ""}).`
            );
        }
        if (derivedOk) {
            rtn.derived = formatVersion(base);
        }
        rtn.how = "override";
        delete rtn.level;
        if (derivedOk && lastPublicTag) {
            rtn.reason = `Chosen explicitly; the commits give ${formatVersion(base)}.`;
        } else if (derivedOk) {
            rtn.reason = `Chosen explicitly; ${formatVersion(base)} was proposed for the first public release.`;
        } else {
            rtn.reason = `Chosen explicitly; the commits since ${lastPublicTag} justify no release.`;
        }
        base = chosen;
    } else if (!derivedOk) {
        return rtn;
    }
    let version = base;
    if (channel === "rc") {
        version = nextCandidate(rules, base, tags);
        if (version.rc > MaxRc) {
            return refused(
                channel,
                lastPublicTag,
                `${formatVersion(base)} has no candidate number left (at most ${MaxRc}).`
            );
        }
    }
    rtn.base = formatVersion(base);
    rtn.version = formatVersion(version);
    rtn.tag = tagOf(rules, version);
    if (tags.some((t) => t.trim() === rtn.tag)) {
        return refused(channel, lastPublicTag, `${rtn.tag} is already tagged.`);
    }
    return rtn;
}
