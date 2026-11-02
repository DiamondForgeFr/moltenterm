// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Your way of publishing" (FR-MC-044, #1151): the detected pipeline told the way a release manager would. Each
// release step of the pipeline model becomes one plain sentence with who does it, built from what the step is (its run
// command, a manual step, its gates, what its tag publishes to, the role of the workflow it dispatches), never parsed
// from its English title. Steps that make one action for the developer read as one sentence (the changelogs in
// several languages, the validation request opened then accepted). Each channel gets its diagram, numbered like the
// sentences. Pure functions, tested without the app.

import type { TFunction } from "../i18n/i18n";
import { applyBump, formatVersion, parseBase, parseVersion } from "../releases/versions";
import type { PipelineReleaseStep, ReleasePhase } from "./mission-model";
import { releaseStepPhases } from "./release-model";
import { TargetLabels } from "./release-setup-analyse-model";
import {
    FlowModel,
    FlowNode,
    rcBranchDisplay,
    SetupChange,
    SetupChannel,
    SetupCheck,
    SetupDraft,
} from "./release-setup-model";
import type { SetupSurvey } from "./release-setup-stepper";

export type PlainKind =
    | "promote"
    | "prepare"
    | "reconcile"
    | "changelog"
    | "labels"
    | "notes"
    | "validation"
    | "merge"
    | "tag"
    | "milestone"
    | "docs"
    | "deploy"
    | "dispatch"
    | "syncback"
    | "custom";

// Who does the step: MoltenTerm alone, the developer by hand, MoltenTerm once the developer confirmed, or a platform
// approval the developer gives.
// validate: the developer reviews and validates what MoltenTerm prepared; only the setup agent's words use it (#1163).
export type PlainWho = "molten" | "you" | "confirm" | "approve" | "validate";

// A value of a sentence: as is, or a list joined in the interface language (keys translated first).
export type PlainVar = string | number | { keys?: string[]; names?: string[] };

// One sentence: an i18n key (mc.setup.plain.say.<key>) and its values, or the step's own title (a custom step).
export type PlainPart = { key?: string; vars?: Record<string, PlainVar>; raw?: string };

export type PlainStep = {
    n: number;
    channel: SetupChannel;
    kind: PlainKind;
    // The pipeline steps the sentence tells, in order.
    ids: string[];
    parts: PlainPart[];
    who: PlainWho;
    // Runs only when it is needed (the reconciliation).
    ifNeeded?: boolean;
    // A step the model cannot classify: its own title, "your step".
    yours?: boolean;
    // The topic of the step's Question button (#1152's ready answers).
    topic: string;
};

export type PlainChannel = {
    channel: SetupChannel;
    steps: PlainStep[];
    // The pipeline's own steps, for the technical details.
    source: PipelineReleaseStep[];
};

export type PlainExamples = { prefix: string; version: string; candidate: string };

export type PlainContext = {
    draft: SetupDraft;
    examples: PlainExamples;
};

const RunRe = /^molten release ([a-z-]+)(.*)$/;
const DispatchRe = /^molten release dispatch\s+(\S+)/;
const ChangelogIdRe = /^changelog(?:-([a-z]{2,3}))?(?:-\d+)?$/;

function verbOf(step: PipelineReleaseStep): { verb: string; args: string } {
    const m = RunRe.exec((step.run ?? "").trim());
    return m ? { verb: m[1], args: m[2] } : { verb: "", args: "" };
}

function unquote(file: string): string {
    return file.replace(/^['"]|['"]$/g, "");
}

// The release steps the committed pipeline declares, per channel; null when the file declares none or is unreadable.
export function declaredRelease(current: string): Partial<Record<SetupChannel, PipelineReleaseStep[]>> {
    if (!current?.trim()) {
        return null;
    }
    try {
        const release = JSON.parse(current)?.release;
        if (release == null || typeof release !== "object") {
            return null;
        }
        return {
            rc: Array.isArray(release.rc) ? release.rc : undefined,
            public: Array.isArray(release.public) ? release.public : undefined,
        };
    } catch {
        return null;
    }
}

function declaredVersions(current: string): { rcformat?: string; firstpublic?: string; tagprefix?: string } {
    try {
        return JSON.parse(current ?? "")?.versions ?? {};
    } catch {
        return {};
    }
}

// The steps each channel tells: the committed pipeline's when it declares the channel, else the draft's proposal.
export function plainSteps(draft: SetupDraft): Record<SetupChannel, PipelineReleaseStep[]> {
    const declared = declaredRelease(draft?.current) ?? {};
    const proposed = draft?.proposal?.release ?? {};
    const pick = (c: SetupChannel) => (declared[c]?.length > 0 ? declared[c] : (proposed[c] ?? []));
    return { rc: pick("rc"), public: pick("public") };
}

// The examples the sentences use: the project's next real version (the last public tag's next minor, or the first
// public version it declares), and its first candidate in the project's numbering.
export function plainExamples(survey: SetupSurvey, draft: SetupDraft): PlainExamples {
    const versions = declaredVersions(draft?.current);
    const prefix = draft?.options?.tagprefix || versions.tagprefix || draft?.facts?.tagprefix || "v";
    const strip = (tag: string) => (tag?.startsWith(prefix) ? tag.slice(prefix.length) : (tag ?? ""));
    let version = "";
    const last = parseBase(strip(survey?.tags?.lastpublic));
    if (last != null) {
        version = formatVersion(applyBump(last, "minor"));
    } else {
        const current = parseVersion((draft?.facts?.currentversion ?? "").replace(/-.*$/, ""));
        const first = parseBase(versions.firstpublic ?? "");
        version = first ? formatVersion(first) : current ? formatVersion(applyBump(current, "minor")) : "1.0.0";
    }
    const format = versions.rcformat ?? "";
    const rcdot = format.includes("rc.") || (!format && draft?.options?.rcformat === "rcdot");
    return { prefix, version, candidate: rcdot ? `${version}-rc.1` : `${version}-1` };
}

// A custom step's own title, with the pipeline's placeholders replaced by the examples.
export function exampleTitle(title: string, ex: PlainExamples, channel: SetupChannel): string {
    const version = channel === "rc" ? ex.candidate : ex.version;
    return (title ?? "")
        .split("{tag}")
        .join(`${ex.prefix}${version}`)
        .split("{version}")
        .join(version)
        .split("X.Y.Z")
        .join(ex.version)
        .replace(/\{[^}]*\}/g, "")
        .trim();
}

function changelogLang(step: PipelineReleaseStep, draft: SetupDraft): string {
    const m = ChangelogIdRe.exec(step.id ?? "");
    if (m?.[1]) {
        return m[1];
    }
    const found = (draft.facts?.changelogs ?? []).find((c) => (step.manual ?? "").includes(c.path));
    return found?.lang ?? "";
}

function isChangelog(step: PipelineReleaseStep, draft: SetupDraft): boolean {
    if (!step.manual) {
        return false;
    }
    if (ChangelogIdRe.test(step.id ?? "")) {
        return true;
    }
    const paths = [
        ...(draft.facts?.changelogs ?? []).map((c) => c.path),
        ...((declaredVersions(draft.current) as { changelogs?: string[] }).changelogs ?? []),
    ];
    return paths.some((p) => p && step.manual.includes(p));
}

type Classified = { kind: PlainKind; step: PipelineReleaseStep };

export function classifyStep(step: PipelineReleaseStep, draft: SetupDraft): PlainKind {
    if (step.notes) {
        return "notes";
    }
    if (step.manual) {
        if (isChangelog(step, draft)) {
            return "changelog";
        }
        return step.id === "bump-labels" ? "labels" : "custom";
    }
    const { verb } = verbOf(step);
    switch (verb) {
        case "promote":
            return "promote";
        case "prepare":
            return "prepare";
        case "reconcile":
            return "reconcile";
        case "notes":
            return "notes";
        case "open-pr":
            return "validation";
        case "merge-pr":
            return "merge";
        case "tag":
        case "finalize":
            return "tag";
        case "close-milestone":
        case "milestone":
            return "milestone";
        case "sync-back":
            return "syncback";
        case "dispatch": {
            const file = unquote(DispatchRe.exec(step.run ?? "")?.[1] ?? "");
            const role = draft.facts?.workflows?.find((w) => w.file === file)?.role;
            return role === "docs" ? "docs" : role === "deploy" ? "deploy" : "dispatch";
        }
    }
    return "custom";
}

function tagPublishes(draft: SetupDraft, channel: SetupChannel): { ships: string[]; envs: string[]; runs: boolean } {
    const files = draft.tagworkflows?.[channel] ?? [];
    const ships: string[] = [];
    for (const wf of files) {
        for (const ship of draft.facts?.workflows?.find((w) => w.file === wf.file)?.ships ?? []) {
            if (!ships.includes(ship)) {
                ships.push(ship);
            }
        }
    }
    const envs = [...new Set(files.flatMap((w) => w.environments ?? []))];
    return { ships, envs, runs: files.length > 0 };
}

function dispatchEnvs(step: PipelineReleaseStep, draft: SetupDraft): string[] {
    const file = unquote(DispatchRe.exec(step.run ?? "")?.[1] ?? "");
    return draft.facts?.workflows?.find((w) => w.file === file)?.environments ?? [];
}

function shipNames(ships: string[]): string[] {
    return ships.map((s) => TargetLabels[s] ?? s);
}

// The sentence parts, who and the topic of one plain step (one or more pipeline steps of the same action).
function tell(
    kind: PlainKind,
    group: PipelineReleaseStep[],
    channel: SetupChannel,
    ctx: PlainContext
): Pick<PlainStep, "parts" | "who" | "ifNeeded" | "yours" | "topic"> {
    const { draft, examples: ex } = ctx;
    const trunk = draft.facts?.branches?.trunk ?? "";
    const release = draft.facts?.branches?.release ?? "";
    const first = group[0];
    const confirmed = group.some((s) => !!s.confirm);
    const gate: PlainWho = confirmed ? "confirm" : "molten";
    const rc = channel === "rc";
    const tag = `${ex.prefix}${rc ? ex.candidate : ex.version}`;
    switch (kind) {
        case "promote": {
            const checks = / --workflow /.test(first.run ?? "");
            return {
                parts: [{ key: checks ? "promoteChecks" : "promote", vars: { trunk, release } }],
                who: gate,
                topic: "branches",
            };
        }
        case "prepare": {
            const fromTrunk = / --pr\b/.test(first.run ?? "");
            const key = `prepare${fromTrunk ? "From" : "On"}${rc ? "Rc" : "Public"}`;
            return {
                parts: [{ key, vars: { trunk, branch: release, candidate: ex.candidate, version: ex.version } }],
                who: gate,
                topic: rc ? "rc" : "prepare",
            };
        }
        case "reconcile":
            return { parts: [{ key: "reconcile", vars: { release } }], who: gate, ifNeeded: true, topic: "reconcile" };
        case "changelog": {
            const langs = [...new Set(group.map((s) => changelogLang(s, draft)).filter(Boolean))];
            const known = langs.every((l) => ["en", "fr", "de", "es", "it", "pt", "nl", "ja", "zh"].includes(l));
            const key = rc ? "changelogRc" : "changelogPublic";
            return {
                parts:
                    langs.length > 0 && known
                        ? [
                              {
                                  key: `${key}Langs`,
                                  vars: { langs: { keys: langs.map((l) => `mc.setup.plain.lang.${l}`) } },
                              },
                          ]
                        : [{ key }],
                who: "you",
                topic: "changelog",
            };
        }
        case "labels":
            return { parts: [{ key: "labels" }], who: "you", topic: "changelog" };
        case "notes":
            return { parts: [{ key: "notes" }], who: gate, topic: "changelog" };
        case "validation":
        case "merge": {
            const merges = group.some((s) => verbOf(s).verb === "merge-pr");
            const parts: PlainPart[] = [{ key: kind === "validation" ? "validation" : "mergeOnly", vars: { release } }];
            if (merges) {
                const required = (draft.facts?.protection?.requiredchecks?.length ?? 0) > 0;
                parts.push({ key: required ? "acceptedChecks" : "acceptedAllowed" });
            }
            return { parts, who: gate, topic: "validation" };
        }
        case "tag": {
            const onRcBranch = / --rc-branch\b/.test(first.run ?? "");
            const finalize = verbOf(first).verb === "finalize";
            const parts: PlainPart[] = [
                { key: finalize ? (rc ? "finalizeRc" : "finalizePublic") : rc ? "tagRc" : "tagPublic", vars: { tag } },
            ];
            const pub = tagPublishes(draft, channel);
            if (onRcBranch && !pub.runs) {
                parts.push({ key: "tagNothingPublished", vars: { release, trunk } });
            } else if (pub.runs) {
                const approval = pub.envs.length > 0 ? "Approval" : "";
                parts.push(
                    pub.ships.length > 0
                        ? { key: `publishTo${approval}`, vars: { targets: { names: shipNames(pub.ships) } } }
                        : { key: `publishRuns${approval}` }
                );
            }
            return {
                parts,
                who: pub.envs.length > 0 ? "approve" : gate,
                topic: pub.envs.length > 0 ? "approval" : pub.runs ? "publish" : "tag",
            };
        }
        case "milestone":
            return { parts: [{ key: "milestone" }], who: gate, topic: "milestone" };
        case "docs":
        case "deploy":
        case "dispatch": {
            const envs = dispatchEnvs(first, draft);
            const parts: PlainPart[] = [{ key: kind }];
            if (envs.length > 0) {
                parts.push({ key: "waitsApproval" });
            }
            return {
                parts,
                who: envs.length > 0 ? "approve" : gate,
                topic: kind === "docs" ? "docs" : "publish",
            };
        }
        case "syncback":
            return { parts: [{ key: "syncback", vars: { release, trunk } }], who: gate, topic: "syncback" };
    }
    return {
        parts: [{ raw: exampleTitle(first.title || first.id, ex, channel) }],
        who: first.manual ? "you" : gate,
        yours: true,
        topic: "manual",
    };
}

// Steps that read as one action: the changelogs one after the other, and the validation request opened then accepted.
function groupSteps(steps: readonly PipelineReleaseStep[], draft: SetupDraft): Classified[][] {
    const groups: Classified[][] = [];
    for (const step of steps ?? []) {
        const kind = classifyStep(step, draft);
        const last = groups[groups.length - 1];
        const lastKind = last?.[last.length - 1]?.kind;
        if (
            last &&
            ((kind === "changelog" && lastKind === "changelog") || (kind === "merge" && lastKind === "validation"))
        ) {
            last.push({ kind, step });
            continue;
        }
        groups.push([{ kind, step }]);
    }
    return groups;
}

export function plainChannel(
    steps: readonly PipelineReleaseStep[],
    channel: SetupChannel,
    ctx: PlainContext
): PlainChannel {
    const plain = groupSteps(steps, ctx.draft).map((group, i) => {
        const kind = group[0].kind;
        return {
            n: i + 1,
            channel,
            kind,
            ids: group.map((g) => g.step.id),
            ...tell(
                kind,
                group.map((g) => g.step),
                channel,
                ctx
            ),
        };
    });
    return { channel, steps: plain, source: [...(steps ?? [])] };
}

// The channels the screen tells, release candidate first; a channel without steps is left out.
export function plainChannels(survey: SetupSurvey, draft: SetupDraft): PlainChannel[] {
    if (draft == null) {
        return [];
    }
    const ctx: PlainContext = { draft, examples: plainExamples(survey, draft) };
    const steps = plainSteps(draft);
    return (["rc", "public"] as SetupChannel[])
        .filter((c) => steps[c].length > 0)
        .map((c) => plainChannel(steps[c], c, ctx));
}

// --- Text --------------------------------------------------------------------------------------------------------

function joinList(items: string[], t: TFunction): string {
    if (items.length <= 1) {
        return items[0] ?? "";
    }
    return `${items.slice(0, -1).join(", ")} ${t("mc.setup.plain.and")} ${items[items.length - 1]}`;
}

export function partText(t: TFunction, part: PlainPart): string {
    if (part.raw != null) {
        return part.raw;
    }
    const vars: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(part.vars ?? {})) {
        if (typeof value === "string" || typeof value === "number") {
            vars[name] = value;
            continue;
        }
        vars[name] = joinList([...(value.keys ?? []).map((k) => t(k)), ...(value.names ?? [])], t);
    }
    return t(`mc.setup.plain.say.${part.key}`, vars);
}

export function stepText(t: TFunction, step: Pick<PlainStep, "parts">): string {
    return step.parts.map((p) => partText(t, p)).join(" ");
}

// --- Diagram -----------------------------------------------------------------------------------------------------

export function stepPoint(n: number): string {
    return `step-${n}`;
}

const NodeKind: Record<PlainKind, FlowNode["kind"]> = {
    promote: "command",
    prepare: "command",
    reconcile: "command",
    changelog: "manual",
    labels: "manual",
    notes: "notes",
    validation: "pr",
    merge: "pr",
    tag: "tag",
    milestone: "dispatch",
    docs: "dispatch",
    deploy: "dispatch",
    dispatch: "dispatch",
    syncback: "command",
    custom: "command",
};

// plainFlowModel draws one channel in plain words: one node per sentence carrying its number (the tag's publication
// beside it on "Published to"), on the branches the developer sees every day. Each node names its step's point, so
// the sentence and the node light together.
export function plainFlowModel(plain: PlainChannel, ctx: PlainContext, t: TFunction): FlowModel {
    const { draft, examples: ex } = ctx;
    const facts = draft.facts;
    const trunk = facts.branches.trunk;
    const single = draft.options?.branchmodel === "single" || trunk === facts.branches.release;
    const release = single ? trunk : facts.branches.release;
    const source = plain.source;
    const runs = source.map((s) => s.run ?? "");
    const viaPr = runs.some((r) => /^molten release (prepare .*--pr\b|open-pr)/.test(r));
    const onRcBranch = runs.some((r) => /^molten release tag .*--rc-branch/.test(r));
    const phases = releaseStepPhases(source);
    const phaseOf = (id: string): ReleasePhase => {
        const i = source.findIndex((s) => s.id === id);
        for (let k = i; k >= 0; k--) {
            if (phases[k]) {
                return phases[k];
            }
        }
        return "cut";
    };
    const branched = viaPr || onRcBranch;
    const nodes: FlowNode[] = [];
    for (const step of plain.steps) {
        const id = step.ids[0];
        const phase = step.kind === "syncback" ? "back" : phaseOf(id);
        const kind = step.yours && source.find((s) => s.id === id)?.manual ? "manual" : NodeKind[step.kind];
        let lane: FlowNode["lane"] = branched && phase !== "back" ? "rc" : "release";
        if (step.kind === "promote" || step.kind === "syncback") {
            lane = "trunk";
        } else if (step.kind === "validation" || step.kind === "merge") {
            lane = "release";
        } else if (step.kind === "tag") {
            lane = onRcBranch ? "rc" : "release";
        } else if (NodeKind[step.kind] === "dispatch") {
            lane = "github";
        } else if (step.yours && phase === "back") {
            lane = "trunk";
        }
        const point = stepPoint(step.n);
        const label =
            step.kind === "tag"
                ? `${ex.prefix}${plain.channel === "rc" ? ex.candidate : ex.version}`
                : step.yours
                  ? (step.parts[0]?.raw ?? id)
                  : t(`mc.setup.plain.node.${step.kind}`, { trunk, release });
        // The diagram finds the promotion, the pull request's merge and the sync-back by their key's last segment.
        const keyId =
            step.kind === "validation" || step.kind === "merge"
                ? "merge-pr"
                : step.kind === "promote"
                  ? "promote"
                  : step.kind === "syncback"
                    ? "sync-back"
                    : id;
        nodes.push({
            key: `${plain.channel}/${keyId}`,
            label,
            kind,
            phase,
            lane,
            point,
            badge: step.n,
            conditional: step.ifNeeded,
            approval: step.who === "approve" && step.kind !== "tag" ? "yes" : undefined,
        });
        if (step.kind === "tag") {
            const pub = tagPublishes(draft, plain.channel);
            for (const ship of pub.ships) {
                nodes.push({
                    key: `${plain.channel}/@to/${ship}`,
                    label: TargetLabels[ship] ?? ship,
                    kind: "target",
                    phase: "publish",
                    lane: "targets",
                    point,
                    approval: pub.envs.length > 0 ? "yes" : undefined,
                });
            }
        }
    }
    return {
        trunk,
        release,
        single,
        nodes,
        promote: plain.steps.some((s) => s.kind === "promote"),
        syncBack: plain.steps.some((s) => s.kind === "syncback"),
        viaPr: branched,
        rcBranch: branched ? rcBranchDisplay(facts).split("X.Y.Z").join(ex.version) : undefined,
    };
}

// --- What changed since last time --------------------------------------------------------------------------------

function changedStep(change: SetupChange): PipelineReleaseStep {
    for (const text of [change.after, change.before]) {
        if (!text) {
            continue;
        }
        try {
            const step = JSON.parse(text);
            if (step && typeof step === "object" && typeof step.id === "string") {
                return step;
            }
        } catch {
            // Not a step: the sentence falls back to the generic one.
        }
    }
    return null;
}

export type PlainChange = {
    key: string;
    kind: SetupChange["kind"];
    local: boolean;
    channel?: SetupChannel;
    step?: PlainStep;
};

// The update check's changes (#1102) as sentences: each changed step told as the screen tells it.
export function plainChanges(check: SetupCheck, survey: SetupSurvey, draft: SetupDraft): PlainChange[] {
    if (check == null || draft == null || check.state !== "update") {
        return [];
    }
    const ctx: PlainContext = { draft, examples: plainExamples(survey, draft) };
    return (check.changes ?? []).map((c) => {
        const step = c.kind === "versions" ? null : changedStep(c);
        const channel = c.channel;
        return {
            key: c.key,
            kind: c.kind,
            local: !!c.local,
            channel,
            step: step && channel ? plainChannel([step], channel, ctx).steps[0] : undefined,
        };
    });
}
