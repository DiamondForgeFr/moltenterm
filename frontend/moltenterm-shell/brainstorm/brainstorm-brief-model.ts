// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The project brief (FR-BOSS-010 AC14, DS-BOSS-009, #2250): what Brokk's `conclude` carries once the first pass of a
// brainstorm is clear. The window checks it with the rules wavesrv applies (pkg/molten/brainstorm/brief.go) before it
// sends his block: a brief that breaks them drops the block, with a reason that never quotes it. wavesrv writes it as
// brief.json, ProjectBrief v1, the contract DiamondForge will import, and adds the header (schema, version, id, source,
// brainstorm, created).

// must match pkg/molten/brainstorm/brief.go
export const BriefSchema = "projectbrief";
export const BriefVersion = 1;
export const BriefSlugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MaxBriefName = 80;
export const MaxBriefLine = 160;
export const MaxBriefProblem = 600;
export const MaxBriefUsers = 300;
export const MaxBriefStep = 300;
export const MaxBriefItems = 12;
export const MaxBriefStack = 80;
export const BriefProfiles = ["", "full", "harness"];

export type BriefScope = { in: string[]; out: string[] };

// What Brokk writes.
export type BriefDraft = {
    name: string;
    slug: string;
    pitch: string;
    problem: string;
    users: string;
    scope?: BriefScope;
    stack?: string[];
    profile?: "" | "full" | "harness";
    profilereason?: string;
    firststep?: string;
    openquestions?: string[];
    language?: string;
};

// brief.json, as wavesrv wrote it.
export type ProjectBrief = BriefDraft & {
    schema: string;
    version: number;
    id: string;
    source: string;
    brainstorm: string;
    created: number;
};

// eslint-disable-next-line no-control-regex
const ControlRuns = /[\u0000-\u001f\u007f]+/g;

function plain(text: string): string {
    return text.replace(ControlRuns, " ").replace(/\s+/g, " ").trim();
}

function textProblem(value: unknown, max: number, required: boolean, what: string): string {
    if (value == null && !required) {
        return "";
    }
    if (typeof value !== "string") {
        return `${what}: not a text`;
    }
    const clean = plain(value);
    if (clean === "" && required) {
        return `${what}: empty`;
    }
    return [...clean].length > max ? `${what}: over ${max} characters` : "";
}

function listProblem(value: unknown, max: number, what: string): string {
    if (value == null) {
        return "";
    }
    if (!Array.isArray(value)) {
        return `${what}: not a list`;
    }
    if (value.length > MaxBriefItems) {
        return `${what}: ${value.length} items, over ${MaxBriefItems}`;
    }
    for (let i = 0; i < value.length; i++) {
        const problem = textProblem(value[i], max, true, `${what} item ${i + 1}`);
        if (problem !== "") {
            return problem;
        }
    }
    return "";
}

// Why a brief breaks ProjectBrief v1, "" when it holds. The reason names the field, never its text.
export function briefProblem(value: unknown): string {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return "not an object";
    }
    const b = value as Record<string, unknown>;
    const scope = b.scope as Record<string, unknown>;
    if (scope != null && (typeof scope !== "object" || Array.isArray(scope))) {
        return "scope: not an object";
    }
    return (
        textProblem(b.name, MaxBriefName, true, "name") ||
        (typeof b.slug === "string" && BriefSlugPattern.test(b.slug) ? "" : "slug: invalid") ||
        textProblem(b.pitch, MaxBriefLine, true, "pitch") ||
        textProblem(b.problem, MaxBriefProblem, true, "problem") ||
        textProblem(b.users, MaxBriefUsers, true, "users") ||
        listProblem(scope?.in, MaxBriefLine, "scope.in") ||
        listProblem(scope?.out, MaxBriefLine, "scope.out") ||
        listProblem(b.stack, MaxBriefStack, "stack") ||
        (b.profile == null || BriefProfiles.includes(b.profile as string) ? "" : "profile: unknown") ||
        textProblem(b.profilereason, MaxBriefLine, false, "profilereason") ||
        textProblem(b.firststep, MaxBriefStep, false, "firststep") ||
        listProblem(b.openquestions, MaxBriefLine, "openquestions") ||
        (b.language == null || typeof b.language === "string" ? "" : "language: not a text")
    );
}
