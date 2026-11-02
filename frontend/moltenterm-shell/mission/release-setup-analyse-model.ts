// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 2a of the pipeline setup (FR-MC-040, DS-MC-030): the reader that turns what step 1's survey and the draft read
// of the repository (branches, the release branch's protection, the workflows and their triggers, environments, tags,
// changelogs, version labels, the committed pipeline) into one model: the numbered points "What we understood", each
// with its sources and answers, and the existing pipeline's diagram. The answers map onto the draft's options for
// step 3. Pure functions, tested without the app.

import type { TFunction } from "../i18n/i18n";
import {
    diverged,
    FlowModel,
    FlowNode,
    rcBranchDisplay,
    requiresPr,
    SetupChannel,
    SetupChoice,
    SetupDraft,
    SetupOptions,
} from "./release-setup-model";
import type { SetupSurvey } from "./release-setup-stepper";

export type PointKind =
    | "branches"
    | "protection"
    | "merge"
    | "publish"
    | "hand"
    | "dispatch"
    | "rc"
    | "declared"
    | "deploy";

// A sentence of a point: an i18n key (mc.setup.analyse.point.<key>), its values, and a count for a plural key.
export type PointText = { key: string; vars?: Record<string, string | number>; count?: number };

// Where a point was read: a file, a key or a command as it is (text), or a translated phrase (key).
export type PointSource = { text?: string; key?: string; vars?: Record<string, string | number> };

export type AnalysisPoint = {
    key: string;
    kind: PointKind;
    text: PointText;
    extras: PointText[];
    sources: PointSource[];
    // To confirm: MoltenTerm cannot decide it alone, Next waits for the answer.
    confirm: boolean;
    // The answers offered (the draft's own choices for the branch model and the merge method), and the one the
    // repository reads as.
    choices: SetupChoice[];
    selected: string;
};

export type PointAnswers = Record<string, string>;

const YesNo: SetupChoice[] = [
    { id: "yes", allowed: true },
    { id: "no", allowed: true },
];

export const TargetLabels: Record<string, string> = {
    npm: "npm",
    githubrelease: "GitHub Release",
    container: "Container",
    pages: "GitHub Pages",
    msi: "MSI",
    nsis: "NSIS",
    dmg: "DMG",
    linux: "Linux",
};

function targetLabel(id: string): string {
    return TargetLabels[id] ?? id;
}

function workflowPath(file: string): string {
    return `.github/workflows/${file}`;
}

function shipsOf(draft: SetupDraft, files: readonly string[]): string[] {
    const ships: string[] = [];
    for (const file of files) {
        for (const ship of draft.facts.workflows.find((w) => w.file === file)?.ships ?? []) {
            if (!ships.includes(ship)) {
                ships.push(ship);
            }
        }
    }
    return ships;
}

// The release steps the committed pipeline declares per channel.
export function declaredSteps(current: string): Record<SetupChannel, number> {
    const counts = { rc: 0, public: 0 };
    if (!current?.trim()) {
        return counts;
    }
    try {
        const release = JSON.parse(current)?.release;
        counts.rc = Array.isArray(release?.rc) ? release.rc.length : 0;
        counts.public = Array.isArray(release?.public) ? release.public.length : 0;
    } catch {
        // An unreadable file is reported by the draft's validation.
    }
    return counts;
}

// The dispatch-only workflows a release may run after publishing (docs, deploy), as the Choices step offers them.
export function dispatchable(draft: SetupDraft) {
    return draft.facts.workflows.filter(
        (w) => w.dispatch && !w.push && (w.role === "docs" || w.role === "deploy") && !(w.requiredinputs?.length > 0)
    );
}

function branchSources(draft: SetupDraft): PointSource[] {
    const b = draft.facts.branches;
    const sources: PointSource[] = [];
    for (const from of [b.trunkfrom, b.releasefrom]) {
        if (!from) {
            continue;
        }
        const source = from === "the default" ? { key: "branchesDefault" } : { text: from };
        if (!sources.some((s) => s.text === source.text && s.key === source.key)) {
            sources.push(source);
        }
    }
    if (draft.facts.rcbranchpattern) {
        sources.push({ text: ".saasfoundry.json workflow.branchNaming.release" });
    }
    return sources;
}

function pointsOnPremise(survey: SetupSurvey, draft: SetupDraft): AnalysisPoint[] {
    const facts = draft.facts;
    const trunk = facts.branches.trunk;
    const release = facts.branches.release;
    const single = trunk === release;
    const prefix = draft.options.tagprefix || facts.tagprefix;
    const points: AnalysisPoint[] = [];
    const point = (
        p: Omit<AnalysisPoint, "extras" | "sources" | "confirm" | "choices" | "selected"> & Partial<AnalysisPoint>
    ) => points.push({ extras: [], sources: [], confirm: false, choices: [], selected: "", ...p });

    point({
        key: "branches",
        kind: "branches",
        text: single
            ? { key: "branchesSingle", vars: { trunk } }
            : facts.rcbranchpattern
              ? { key: "branchesRc", vars: { trunk, release, rc: facts.rcbranchpattern } }
              : { key: "branchesTwo", vars: { trunk, release } },
        sources: branchSources(draft),
    });

    const p = facts.protection;
    if (!single && p != null) {
        const models = ["rcpr", "promote"]
            .map((id) => (draft.branchmodels ?? []).find((c) => c.id === id))
            .filter(Boolean);
        const prWorkflows = facts.workflows.filter((w) => w.pullrequest).map((w) => w.file);
        const extras: PointText[] = [];
        const sources: PointSource[] = (p.sources ?? []).map((s) =>
            s.code === "ruleset" ? { key: "ruleset", vars: { name: s.path ?? "" } } : { key: "classic" }
        );
        let text: PointText;
        let selected = draft.defaults.branchmodel === "rcpr" ? "rcpr" : "promote";
        let confirm = false;
        if (!p.read) {
            text = { key: "protectionUnread", vars: { release } };
            extras.push({ key: "protectionUnreadWhy", vars: { error: p.error ?? "" } });
            selected = "rcpr";
            confirm = true;
            sources.push({ text: `gh api rules/branches/${release}` });
        } else if (requiresPr(p)) {
            text = { key: "protectionPr", vars: { release } };
            if (p.requiredchecks?.length > 0) {
                extras.push({
                    key: "protectionChecks",
                    vars: { checks: p.requiredchecks.join(", ") },
                    count: p.requiredchecks.length,
                });
            }
            extras.push({ key: p.bypass === "pull_requests_only" ? "protectionBypassPr" : "protectionNoBypass" });
            selected = "rcpr";
        } else {
            text = { key: p.bypass === "always" ? "protectionBypassable" : "protectionNone", vars: { release } };
        }
        if (prWorkflows.length > 0) {
            extras.push({ key: "protectionPrWorkflows", vars: { workflows: prWorkflows.join(", ") } });
        }
        if (p.read && sources.length === 0) {
            sources.push({ text: `gh api rules/branches/${release}` });
        }
        point({ key: "protection", kind: "protection", text, extras, sources, choices: models, selected, confirm });

        const merges = draft.merges ?? [];
        const method = draft.defaults.merge || "merge";
        const mergeExtras: PointText[] = [];
        if ((p.mergemethods ?? []).length === 1) {
            mergeExtras.push({ key: "mergeOnly" });
        }
        if (survey?.tags?.lastmerge && survey.tags.lastpublic) {
            mergeExtras.push({ key: "mergeHistory", vars: { tag: survey.tags.lastpublic } });
        }
        const mergeSources: PointSource[] = [];
        if (p.read) {
            mergeSources.push({ key: "mergeMethods", vars: { methods: (p.mergemethods ?? []).join(", ") } });
        }
        if (survey?.tags?.lastpublic) {
            mergeSources.push({ text: `git rev-list --parents ${survey.tags.lastpublic}` });
        }
        point({
            key: "merge",
            kind: "merge",
            text: { key: `merge.${method}` },
            extras: mergeExtras,
            sources: mergeSources,
            choices: merges,
            selected: method,
        });
    }

    const publicFiles = (draft.tagworkflows?.public ?? []).map((w) => w.file);
    const tests = draft.tagci?.public ?? [];
    const tag = `${prefix}{version}`;
    if (publicFiles.length > 0) {
        const ships = shipsOf(draft, publicFiles);
        const extras: PointText[] = [];
        const envs = [...new Set((draft.tagworkflows?.public ?? []).flatMap((w) => w.environments ?? []))];
        if (tests.length > 0) {
            extras.push({ key: "publishTests", vars: { tests: tests.join(", ") } });
        }
        if (envs.length > 0) {
            extras.push({ key: "publishApproval", vars: { environments: envs.join(", ") } });
        }
        point({
            key: "publish",
            kind: "publish",
            text:
                ships.length > 0
                    ? {
                          key: "publishTag",
                          vars: { tag, workflows: publicFiles.join(", "), targets: ships.map(targetLabel).join(", ") },
                      }
                    : { key: "publishTagRuns", vars: { tag, workflows: publicFiles.join(", ") } },
            extras,
            sources: (draft.tagworkflows?.public ?? []).map((w) => ({
                text:
                    (w.environments ?? []).length > 0
                        ? `${workflowPath(w.file)} · environment ${w.environments.join(", ")}`
                        : workflowPath(w.file),
            })),
        });
    } else {
        point({
            key: "publish",
            kind: "publish",
            text: { key: "publishNone", vars: { tag } },
            extras: tests.length > 0 ? [{ key: "publishTests", vars: { tests: tests.join(", ") } }] : [],
            sources: [{ text: ".github/workflows" }],
        });
    }

    const changelogs = facts.changelogs ?? [];
    const labels = draft.defaults.labels ?? [];
    if (changelogs.length + labels.length > 0) {
        const files = [...changelogs.map((c) => c.path), ...[...new Set(labels.map((l) => l.path))]];
        const extras: PointText[] = [];
        for (const l of labels) {
            const found = facts.labels?.find((x) => x.path === l.path && x.line === l.line);
            if (found && facts.currentversion && found.version !== facts.currentversion) {
                extras.push({
                    key: "handBehind",
                    vars: { path: found.path, version: found.version, current: facts.currentversion },
                });
            }
        }
        point({
            key: "hand",
            kind: "hand",
            text: { key: "hand", vars: { files: files.join(", ") }, count: changelogs.length + labels.length },
            extras,
            sources: [
                ...changelogs.map((c) => ({ text: c.path })),
                ...labels.map((l) => ({ text: `${l.path}:${l.line}` })),
            ],
            confirm: true,
            choices: YesNo,
            selected: "yes",
        });
    }

    for (const w of dispatchable(draft)) {
        const envs = w.environments ?? [];
        point({
            key: `dispatch/${w.file}`,
            kind: "dispatch",
            text: { key: w.role === "docs" ? "dispatchDocs" : "dispatchDeploy", vars: { file: w.file } },
            extras: envs.length > 0 ? [{ key: "dispatchApproval", vars: { environments: envs.join(", ") } }] : [],
            sources: [{ text: `${workflowPath(w.file)} · on: workflow_dispatch` }],
            confirm: true,
            choices: YesNo,
            selected: draft.defaults.dispatch?.some((d) => d.workflow === w.file) ? "yes" : "no",
        });
    }

    const declared = declaredSteps(draft.current);
    if (declared.rc === 0) {
        const rcFiles = (draft.tagworkflows?.rc ?? []).map((w) => w.file);
        const rcTests = draft.tagci?.rc ?? [];
        const extras: PointText[] = [];
        if (rcTests.length > 0 && rcFiles.length === 0) {
            extras.push({ key: "rcTests", vars: { tests: rcTests.join(", ") } });
        }
        if ((survey?.tags?.pre ?? 0) > 0) {
            extras.push({ key: "rcPreTags", count: survey.tags.pre });
        }
        point({
            key: "rc",
            kind: "rc",
            text:
                rcFiles.length > 0
                    ? { key: "rcPublished", vars: { workflows: rcFiles.join(", "), tag: `${prefix}{version}-N` } }
                    : { key: "rcNone" },
            extras,
            sources: [
                ...rcFiles.map((f) => ({ text: workflowPath(f) })),
                ...(rcFiles.length === 0 ? [{ text: `git tag --list '${prefix}*-*'` }] : []),
            ],
            choices: [
                { id: "keep", allowed: true },
                { id: "skip", allowed: true },
            ],
            selected: rcFiles.length > 0 ? "keep" : "skip",
        });
    }
    if (declared.rc + declared.public > 0) {
        point({
            key: "declared",
            kind: "declared",
            text: { key: "declared", vars: { rc: declared.rc, public: declared.public } },
            sources: [{ text: `.molten/project.json · ${draft.pr?.ref || "release"}` }],
        });
    }
    return points;
}

function pointsSaas(draft: SetupDraft): AnalysisPoint[] {
    const facts = draft.facts;
    const points: AnalysisPoint[] = [
        {
            key: "branches",
            kind: "branches",
            text: { key: "branchesDeploy", vars: { release: facts.branches.release } },
            extras: [],
            sources: branchSources(draft),
            confirm: false,
            choices: [],
            selected: "",
        },
    ];
    for (const d of draft.deploytargets ?? []) {
        if (!d.dispatch) {
            continue;
        }
        points.push({
            key: `deploy/${d.environment}`,
            kind: "deploy",
            text: { key: "deploy", vars: { environment: d.environment, workflow: d.workflow } },
            extras: [],
            sources: [{ text: `${workflowPath(d.workflow)} · environment ${d.environment}` }],
            confirm: false,
            choices: YesNo,
            selected: draft.defaults.environments?.includes(d.environment) ? "yes" : "no",
        });
    }
    return points;
}

// analysePipeline: the points of the existing pipeline, in the order the list numbers them.
export function analysePipeline(survey: SetupSurvey, draft: SetupDraft): AnalysisPoint[] {
    if (draft == null) {
        return [];
    }
    return draft.options.kind === "saas" ? pointsSaas(draft) : pointsOnPremise(survey, draft);
}

export function answerOf(point: AnalysisPoint, answers: PointAnswers): string {
    return answers?.[point.key] ?? point.selected;
}

// The points still to confirm, which keep Next disabled.
export function pendingPoints(points: readonly AnalysisPoint[], answers: PointAnswers): AnalysisPoint[] {
    return points.filter((p) => p.confirm && answers?.[p.key] == null);
}

export function pointNumbers(points: readonly AnalysisPoint[]): Record<string, number> {
    const numbers: Record<string, number> = {};
    points.forEach((p, i) => {
        numbers[p.key] = i + 1;
    });
    return numbers;
}

// optionsOfAnswers turns the answers (or, unanswered, what the repository reads as) into the draft's options; keys
// limits it to those points.
export function optionsOfAnswers(
    options: SetupOptions,
    draft: SetupDraft,
    points: readonly AnalysisPoint[],
    answers: PointAnswers,
    keys?: readonly string[]
): SetupOptions {
    let next: SetupOptions = { ...options };
    for (const p of points) {
        if (keys != null && !keys.includes(p.key)) {
            continue;
        }
        const answer = answerOf(p, answers);
        switch (p.kind) {
            case "protection":
                if (answer === "rcpr" && next.branchmodel !== "rcpr") {
                    next = {
                        ...next,
                        branchmodel: "rcpr",
                        reconcile: !(draft.facts.divergence?.notequivalent > 0),
                    };
                } else if (answer === "promote" && next.branchmodel === "rcpr") {
                    next = { ...next, branchmodel: "promote", reconcile: false };
                }
                break;
            case "merge":
                next = { ...next, merge: answer };
                break;
            case "hand":
                next =
                    answer === "yes"
                        ? {
                              ...next,
                              changelogs: (draft.facts.changelogs ?? []).map((c) => c.path),
                              labels: draft.defaults.labels ?? [],
                          }
                        : { ...next, changelogs: [], labels: [] };
                break;
            case "dispatch": {
                const file = p.key.slice("dispatch/".length);
                const rest = (next.dispatch ?? []).filter((d) => d.workflow !== file);
                next = {
                    ...next,
                    dispatch: answer === "yes" ? [...rest, { workflow: file, channel: "public" }] : rest,
                };
                break;
            }
            case "rc": {
                const rest = (next.channels ?? []).filter((c) => c !== "rc");
                const canAdd = draft.facts.missing.includes("rc");
                next = { ...next, channels: answer === "keep" && canAdd ? ["rc", ...rest] : rest };
                break;
            }
            case "deploy": {
                const env = p.key.slice("deploy/".length);
                const rest = (next.environments ?? []).filter((e) => e !== env);
                next = { ...next, environments: answer === "yes" ? [...rest, env] : rest };
                break;
            }
        }
    }
    return next;
}

export function sameOptions(a: SetupOptions, b: SetupOptions): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

// --- The existing pipeline's diagram -------------------------------------------------------------------------------

function baseName(path: string): string {
    return path.split("/").pop() ?? path;
}

// existingFlowModel draws one channel of the existing pipeline as the answers have it: the RC branch or the
// promotion, the hand steps, the pull request with its required checks, the merge commit, the tag, the workflows the
// tag starts with their approvals, what they publish to, the dispatch-only workflows (dashed while to confirm) and
// the sync-back. Each node names its point, and the first node of a point carries its number.
export function existingFlowModel(
    survey: SetupSurvey,
    draft: SetupDraft,
    points: readonly AnalysisPoint[],
    answers: PointAnswers,
    channel: SetupChannel,
    t: TFunction
): FlowModel {
    const facts = draft.facts;
    const trunk = facts.branches.trunk;
    const release = facts.branches.release;
    const single = trunk === release;
    const prefix = draft.options.tagprefix || facts.tagprefix;
    const byKey = new Map(points.map((p) => [p.key, p]));
    const answer = (key: string, fallback: string) => {
        const p = byKey.get(key);
        return p ? answerOf(p, answers) : fallback;
    };
    const prFlow = !single && answer("protection", draft.defaults.branchmodel) === "rcpr";
    const rcFiles = (draft.tagworkflows?.rc ?? []).map((w) => w.file);
    // A candidate nothing publishes stays on its RC branch (the template's --rc-branch).
    const onRcBranch = channel === "rc" && prFlow && rcFiles.length === 0;
    const work: FlowNode["lane"] = prFlow ? "rc" : "release";
    const tagPoint = channel === "rc" ? "rc" : "publish";
    const nodes: FlowNode[] = [];
    const add = (node: FlowNode) => nodes.push(node);
    const c = channel;

    if (!prFlow && !single) {
        add({
            key: `${c}/promote`,
            label: t("mc.setup.analyse.node.promote"),
            kind: "command",
            phase: "prepare",
            lane: "trunk",
            point: "branches",
        });
    }
    add({
        key: `${c}/prepare`,
        label: t("mc.setup.analyse.node.bump"),
        kind: "command",
        phase: "prepare",
        lane: work,
        point: "branches",
    });
    if (prFlow && diverged(facts.divergence)) {
        add({
            key: `${c}/reconcile`,
            label: t("mc.setup.analyse.node.reconcile"),
            kind: "command",
            phase: "prepare",
            lane: "rc",
            point: "protection",
            conditional: true,
        });
    }
    if (answer("hand", "no") === "yes") {
        for (const cl of facts.changelogs ?? []) {
            add({
                key: `${c}/hand/${cl.path}`,
                label: t("mc.setup.analyse.node.changelog", { lang: cl.lang.toUpperCase() }),
                kind: "manual",
                phase: "cut",
                lane: work,
                point: "hand",
            });
        }
        for (const path of [...new Set((draft.defaults.labels ?? []).map((l) => l.path))]) {
            add({
                key: `${c}/hand/${path}`,
                label: baseName(path),
                kind: "manual",
                phase: "cut",
                lane: work,
                point: "hand",
            });
        }
    }
    add({ key: `${c}/commit`, label: t("mc.setup.analyse.node.commit"), kind: "command", phase: "cut", lane: work });
    if (prFlow && !onRcBranch) {
        const checks = facts.protection?.read ? (facts.protection.requiredchecks ?? []).join(", ") : "";
        add({
            key: `${c}/open-pr`,
            label: t("mc.setup.analyse.node.pr", { release }),
            kind: "pr",
            phase: "cut",
            lane: "release",
            point: "protection",
            checks: checks || undefined,
        });
        for (const w of facts.workflows.filter((w) => w.pullrequest)) {
            add({
                key: `${c}/@pr/${w.file}`,
                label: w.file,
                kind: "workflow",
                phase: "cut",
                lane: "github",
                point: "protection",
            });
        }
        const method = answer("merge", draft.defaults.merge || "merge");
        add({
            key: `${c}/merge-pr`,
            label: t(`mc.setup.analyse.node.merge.${method}`),
            kind: "command",
            phase: "cut",
            lane: "release",
            point: "merge",
        });
    }
    add({
        key: `${c}/@tag`,
        label: channel === "rc" ? `${prefix}X.Y.Z-N` : `${prefix}X.Y.Z`,
        kind: "tag",
        phase: "cut",
        lane: onRcBranch ? "rc" : "release",
        point: tagPoint,
    });
    for (const file of draft.tagci?.[c] ?? []) {
        add({
            key: `${c}/@ci/${file}`,
            label: file,
            kind: "workflow",
            phase: "build",
            lane: "github",
            point: tagPoint,
        });
    }
    const tagWorkflows = draft.tagworkflows?.[c] ?? [];
    for (const w of tagWorkflows) {
        add({
            key: `${c}/@wf/${w.file}`,
            label: w.name || w.file,
            kind: "workflow",
            phase: "build",
            lane: "github",
            approval: (w.environments ?? []).join(", ") || undefined,
            point: tagPoint,
        });
    }
    for (const ship of shipsOf(
        draft,
        tagWorkflows.map((w) => w.file)
    )) {
        add({
            key: `${c}/@to/${ship}`,
            label: targetLabel(ship),
            kind: "target",
            phase: "publish",
            lane: "targets",
            point: tagPoint,
        });
    }
    if (channel === "public") {
        for (const w of dispatchable(draft)) {
            const key = `dispatch/${w.file}`;
            const p = byKey.get(key);
            if (p == null) {
                continue;
            }
            const unanswered = answers?.[key] == null;
            if (answerOf(p, answers) !== "yes" && !unanswered) {
                continue;
            }
            add({
                key: `${c}/dispatch-${w.file}`,
                label: w.file,
                kind: "dispatch",
                phase: "publish",
                lane: "github",
                approval: (w.environments ?? []).join(", ") || undefined,
                point: key,
                conditional: unanswered,
            });
            for (const ship of w.ships ?? []) {
                add({
                    key: `${c}/@to/${w.file}/${ship}`,
                    label: targetLabel(ship),
                    kind: "target",
                    phase: "publish",
                    lane: "targets",
                    point: key,
                    conditional: unanswered,
                });
            }
        }
    }
    if (!single && !onRcBranch) {
        add({
            key: `${c}/sync-back`,
            label: t("mc.setup.analyse.node.syncBack", { trunk }),
            kind: prFlow ? "pr" : "command",
            phase: "back",
            lane: "trunk",
        });
    }
    const numbers = pointNumbers(points);
    const badged = new Set<string>();
    for (const node of nodes) {
        if (node.point == null || badged.has(node.point) || numbers[node.point] == null) {
            continue;
        }
        badged.add(node.point);
        node.badge = numbers[node.point];
        node.question = byKey.get(node.point).confirm && answers?.[node.point] == null;
    }
    return {
        trunk,
        release: single ? trunk : release,
        single,
        nodes,
        promote: !prFlow && !single,
        syncBack: !single,
        viaPr: prFlow,
        rcBranch: prFlow ? rcBranchDisplay(facts) : undefined,
    };
}

// The SaaS flow: the release branch deployed to each environment its workflow names.
export function existingSaasModel(
    draft: SetupDraft,
    points: readonly AnalysisPoint[],
    answers: PointAnswers
): FlowModel {
    const numbers = pointNumbers(points);
    const nodes: FlowNode[] = [];
    for (const p of points) {
        if (p.kind !== "deploy" || answerOf(p, answers) !== "yes") {
            continue;
        }
        const env = p.key.slice("deploy/".length);
        nodes.push({
            key: `steps/${env}`,
            label: env,
            kind: "deploy",
            phase: "publish",
            lane: "github",
            point: p.key,
            badge: numbers[p.key],
        });
    }
    return {
        trunk: draft.facts.branches.trunk,
        release: draft.facts.branches.release,
        single: false,
        nodes,
        promote: true,
        syncBack: false,
        viaPr: false,
    };
}
