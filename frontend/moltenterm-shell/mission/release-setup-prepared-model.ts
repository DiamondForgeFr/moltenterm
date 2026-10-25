// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 3 of the pipeline setup (#1104, FR-MC-038): the prepared pipeline read as changes against the committed one,
// change by change (release steps by channel, versions fields, the other blocks the setup owns), the keys it leaves
// untouched, the commands that will ask for trust, the files the pull request writes, and the diagram's marks. Pure
// functions over the two texts, so the list follows the agent's ticked changes like the diff does.

import type { FlowModel, SetupChannel, SetupDraft, SetupOptions, SetupProposedFile } from "./release-setup-model";

export const PipelinePath = ".molten/project.json";
export const RecordPath = ".molten/release-setup.json";

// The top-level keys the setup writes (MergeOwned in pkg/molten/pipelinesetup): every other one stays byte for byte.
const OwnedKeys = new Set(["release", "versions", "branches", "steps"]);

type Json = Record<string, any>;

export type PreparedCheck = { path: string; contains: string };

export type PreparedStepChange = {
    key: string;
    channel: SetupChannel;
    id: string;
    kind: "added" | "changed" | "removed";
    title: string;
    manual: boolean;
    run?: string;
    check?: PreparedCheck;
    before?: string;
    after?: string;
};

export type PreparedFieldChange = {
    // "versions.format", "versions.files", "branches", "steps".
    key: string;
    kind: "added" | "changed" | "removed";
    before?: string;
    after?: string;
};

export type PreparedPipelineDiff = {
    steps: PreparedStepChange[];
    fields: PreparedFieldChange[];
    // The top-level keys of the file the pull request leaves as they are.
    untouched: string[];
};

export function parsePipeline(text: string): Json {
    if (text == null || text.trim() === "") {
        return {};
    }
    try {
        const parsed = JSON.parse(text);
        return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function textOf(value: unknown): string {
    return value === undefined ? undefined : JSON.stringify(value, null, 4);
}

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function stepsOf(p: Json, channel: SetupChannel): Json[] {
    const steps = p?.release?.[channel];
    return Array.isArray(steps) ? steps.filter((s) => s != null && typeof s.id === "string") : [];
}

function stepChange(channel: SetupChannel, kind: PreparedStepChange["kind"], before: Json, after: Json) {
    const step = after ?? before;
    const manual = typeof step.manual === "string" && step.manual.trim() !== "";
    return {
        key: `${channel}/${step.id}`,
        channel,
        id: step.id,
        kind,
        title: step.title || step.id,
        manual,
        run: manual ? undefined : step.run || undefined,
        check: step.check?.path ? { path: step.check.path, contains: step.check.contains ?? "" } : undefined,
        before: before ? textOf(before) : undefined,
        after: after ? textOf(after) : undefined,
    };
}

// The channel's steps in the proposed order, the removed ones last (channelChanges in update.go).
function channelChanges(channel: SetupChannel, current: Json[], proposed: Json[]): PreparedStepChange[] {
    const rtn: PreparedStepChange[] = [];
    for (const p of proposed) {
        const c = current.find((s) => s.id === p.id);
        if (c == null) {
            rtn.push(stepChange(channel, "added", null, p));
        } else if (!same(c, p)) {
            rtn.push(stepChange(channel, "changed", c, p));
        }
    }
    for (const c of current) {
        if (!proposed.some((s) => s.id === c.id)) {
            rtn.push(stepChange(channel, "removed", c, null));
        }
    }
    return rtn;
}

function fieldChange(key: string, before: unknown, after: unknown): PreparedFieldChange {
    if (same(before, after)) {
        return null;
    }
    const kind = before === undefined ? "added" : after === undefined ? "removed" : "changed";
    return { key, kind, before: textOf(before), after: textOf(after) };
}

// versions field by field; the version files entry by entry, each one being a file the release bumps.
function versionsChanges(before: Json, after: Json): PreparedFieldChange[] {
    const rtn: PreparedFieldChange[] = [];
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
    for (const key of keys) {
        const b = before?.[key];
        const a = after?.[key];
        if (key === "files" && (Array.isArray(a) || Array.isArray(b))) {
            const was: unknown[] = Array.isArray(b) ? b : [];
            const now: unknown[] = Array.isArray(a) ? a : [];
            for (const entry of now) {
                if (!was.some((e) => same(e, entry))) {
                    rtn.push({ key: "versions.files", kind: "added", after: JSON.stringify(entry) });
                }
            }
            for (const entry of was) {
                if (!now.some((e) => same(e, entry))) {
                    rtn.push({ key: "versions.files", kind: "removed", before: JSON.stringify(entry) });
                }
            }
            continue;
        }
        const change = fieldChange(`versions.${key}`, b, a);
        if (change) {
            rtn.push(change);
        }
    }
    return rtn;
}

// pipelineDiff reads the proposed file against the committed one; null when either is not JSON (the raw diff then).
export function pipelineDiff(current: string, proposed: string): PreparedPipelineDiff {
    const before = parsePipeline(current);
    const after = parsePipeline(proposed);
    if (before == null || after == null) {
        return null;
    }
    const steps = [
        ...channelChanges("rc", stepsOf(before, "rc"), stepsOf(after, "rc")),
        ...channelChanges("public", stepsOf(before, "public"), stepsOf(after, "public")),
    ];
    const fields = versionsChanges(before.versions, after.versions);
    for (const key of ["branches", "steps"]) {
        const change = fieldChange(key, before[key], after[key]);
        if (change) {
            fields.push(change);
        }
    }
    const untouched = Object.keys(before).filter(
        (key) => key !== "schema" && !OwnedKeys.has(key) && same(before[key], after[key])
    );
    return { steps, fields, untouched };
}

export function diffCounts(diff: PreparedPipelineDiff): { added: number; changed: number; removed: number } {
    const all = [...(diff?.steps ?? []), ...(diff?.fields ?? [])];
    return {
        added: all.filter((c) => c.kind === "added").length,
        changed: all.filter((c) => c.kind === "changed").length,
        removed: all.filter((c) => c.kind === "removed").length,
    };
}

// --- Commands to approve -----------------------------------------------------------------------------------------

export type PreparedCommand = {
    run: string;
    // Where the command runs: "rc/prepare", "public/prepare", or "versions.format".
    places: string[];
};

type Declared = { place: string; run: string; cwd?: string; env?: Json };

// The commands the trust rule hashes (PipelineCommands in pkg/molten/mission/trust.go) for the release setup's keys.
function declaredCommands(p: Json): Declared[] {
    const rtn: Declared[] = [];
    for (const channel of ["rc", "public"] as SetupChannel[]) {
        for (const s of stepsOf(p, channel)) {
            if ((typeof s.manual === "string" && s.manual.trim() !== "") || !s.run) {
                continue;
            }
            rtn.push({ place: `${channel}/${s.id}`, run: s.run, cwd: s.cwd, env: s.env });
        }
    }
    if (typeof p?.versions?.format === "string" && p.versions.format.trim() !== "") {
        rtn.push({ place: "versions.format", run: p.versions.format.trim() });
    }
    for (const s of Array.isArray(p?.steps) ? p.steps : []) {
        if (s?.run) {
            rtn.push({ place: `steps/${s.id}`, run: s.run, cwd: s.cwd, env: s.env });
        }
    }
    return rtn;
}

// newCommands: the commands the prepared file adds or changes (its command, folder or environment), one per text.
export function newCommands(current: string, proposed: string): PreparedCommand[] {
    const before = declaredCommands(parsePipeline(current) ?? {});
    const after = declaredCommands(parsePipeline(proposed) ?? {});
    const rtn: PreparedCommand[] = [];
    for (const c of after) {
        const was = before.find((b) => b.place === c.place);
        if (was && was.run === c.run && same(was.cwd, c.cwd) && same(was.env, c.env)) {
            continue;
        }
        const known = rtn.find((r) => r.run === c.run);
        if (known) {
            known.places.push(c.place);
        } else {
            rtn.push({ run: c.run, places: [c.place] });
        }
    }
    return rtn;
}

// --- What the draft proposes beyond the steps (#1095) -----------------------------------------------------------------

// The step ids whose check the draft proposed (absent from the committed step), and those the developer dropped.
export function proposedChecks(draft: SetupDraft, options: SetupOptions): string[] {
    const current = parsePipeline(draft?.current) ?? {};
    const ids: string[] = [];
    for (const channel of ["rc", "public"] as SetupChannel[]) {
        for (const s of draft?.proposal?.release?.[channel] ?? []) {
            const check = (s as Json).check;
            if (!check?.path) {
                continue;
            }
            const was = stepsOf(current, channel).find((c) => c.id === s.id);
            if (!same(was?.check, check) && !ids.includes(s.id)) {
                ids.push(s.id);
            }
        }
    }
    for (const id of options?.nocheck ?? []) {
        if (!ids.includes(id)) {
            ids.push(id);
        }
    }
    return ids;
}

// The draft proposes versions.format (the committed file declares none), or the developer dropped it.
export function proposesFormat(draft: SetupDraft, options: SetupOptions): boolean {
    if (options?.noformat) {
        return true;
    }
    const current = parsePipeline(draft?.current) ?? {};
    const format = draft?.proposal?.versions?.format;
    return typeof format === "string" && format !== "" && !current?.versions?.format;
}

export function toggledCheck(options: SetupOptions, id: string, on: boolean): SetupOptions {
    const rest = (options.nocheck ?? []).filter((x) => x !== id);
    return { ...options, nocheck: on ? rest : [...rest, id] };
}

// --- Files of the pull request -----------------------------------------------------------------------------------

// One file the pull request writes. "pipeline" is listed change by change, "record" with why MoltenTerm keeps it;
// "whole" is a new file shown in full (the publish workflow of step 2b, FR-MC-041; one more generated file, such as
// the pipeline's documentation, is one more entry of this kind).
export type PreparedFile = {
    path: string;
    status: "new" | "changed";
    kind: "pipeline" | "record" | "whole";
    content?: string;
    // An i18n key with its values, saying what the file is for.
    introKey?: string;
    introVars?: Record<string, string>;
    warningKey?: string;
    // A publish workflow (FR-MC-041): where it publishes, read as mc.setup.describe.target.<id>.
    targets?: string[];
};

// The files step 2b proposes beside the pipeline (FR-MC-041): new, shown whole, and why each one is there.
export function proposedFiles(files: SetupProposedFile[]): PreparedFile[] {
    return (files ?? []).map((file) => ({
        path: file.path,
        status: "new",
        kind: "whole",
        content: file.content,
        introKey: "mc.setup.describe.fileIntro",
        targets: file.targets ?? [],
        warningKey: (file.targets ?? []).includes("npm") ? "mc.setup.describe.npmSecret" : undefined,
    }));
}

export function preparedFiles(draft: SetupDraft, proposed: string, extra: PreparedFile[] = []): PreparedFile[] {
    const rtn: PreparedFile[] = [];
    if (proposed !== draft.current) {
        rtn.push({ path: PipelinePath, status: draft.current ? "changed" : "new", kind: "pipeline" });
    }
    const release = parsePipeline(proposed)?.release;
    if (release != null && (stepsOf({ release }, "rc").length > 0 || stepsOf({ release }, "public").length > 0)) {
        rtn.push({ path: RecordPath, status: draft.recordexists ? "changed" : "new", kind: "record" });
    }
    return [...rtn, ...extra];
}

// --- The diagram of the result ------------------------------------------------------------------------------------

// preparedDraft: the draft drawing the proposed file's release steps, so the diagram follows the ticked changes.
export function preparedDraft(draft: SetupDraft, proposed: string): SetupDraft {
    const release = parsePipeline(proposed)?.release;
    if (release == null || proposed === draft.proposed) {
        return draft;
    }
    return { ...draft, proposal: { ...draft.proposal, release } };
}

export function markFlow(model: FlowModel, diff: PreparedPipelineDiff): FlowModel {
    if (diff == null) {
        return model;
    }
    const marks = new Map<string, "added" | "changed">();
    for (const c of diff.steps) {
        if (c.kind !== "removed") {
            marks.set(c.key, c.kind);
        }
    }
    return { ...model, nodes: model.nodes.map((n) => (marks.has(n.key) ? { ...n, mark: marks.get(n.key) } : n)) };
}

// --- The pull request, followed ----------------------------------------------------------------------------------

// must match SetupPrStatus in pkg/molten/mission/setupprstatus.go
export type SetupPrStatus = {
    number: number;
    url: string;
    state: "open" | "merged" | "closed";
    draft: boolean;
    head: string;
    base: string;
    checks: "none" | "pending" | "success" | "failure" | "neutral";
    success: number;
    failure: number;
    pending: number;
};

export function prFollowDone(status: SetupPrStatus): boolean {
    return status != null && status.state !== "open";
}

// The i18n key of the line saying where the pull request is.
export function prFollowKey(status: SetupPrStatus): string {
    if (status.state === "merged") {
        return "mc.setup.prepared.follow.merged";
    }
    if (status.state === "closed") {
        return "mc.setup.prepared.follow.closed";
    }
    switch (status.checks) {
        case "pending":
            return "mc.setup.prepared.follow.running";
        case "failure":
            return "mc.setup.prepared.follow.failed";
        case "success":
            return status.draft ? "mc.setup.prepared.follow.greenDraft" : "mc.setup.prepared.follow.green";
    }
    return status.draft ? "mc.setup.prepared.follow.noChecksDraft" : "mc.setup.prepared.follow.noChecks";
}
