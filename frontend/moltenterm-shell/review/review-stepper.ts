// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Validate's stepper, the pure part (#672, FR-REV-012, FR-REV-013): the five steps in the order they happen (checks,
// the merge, ticket, cleanup, other open PRs), built from the plan, the merge record and the cleanup result.
// Before the merge every step says what it will do; then each one shows its state and what it did, skipped steps say
// why, and a kept worktree says exactly what removing it would lose. wavesrv gives codes and data: every sentence is
// written here, through the interface's language.

import type { I18nVars } from "../i18n/i18n-core";
import type {
    ReviewCleanupPanel,
    ReviewCleanupPr,
    ReviewCleanupResult,
    ReviewCleanupStepResult,
    ReviewWorktreeLoss,
} from "./review-cleanup";
import type {
    ReviewCheckState,
    ReviewMergeCheck,
    ReviewMergeMethod,
    ReviewMergePlan,
    ReviewMergeRecord,
} from "./review-client";

export type Translate = (key: string, vars?: I18nVars) => string;

export type StepState = "todo" | "running" | "done" | "skipped" | "needs" | "failed";

export type StepRow = {
    id: string;
    label: string;
    state: StepState;
    // The sentences under the row; error: a raw gh or git error, shown as such.
    lines: string[];
    error?: string;
    url?: string;
    // A PR the merge put in conflict with no agent on its branch: the row offers to start one (#691).
    startAgent?: ReviewCleanupPr;
};

export type ValidateStepId = "checks" | "merge" | "ticket" | "cleanup" | "others";

export type ValidateStep = {
    id: ValidateStepId;
    title: string;
    state: StepState;
    lines: string[];
    error?: string;
    rows: StepRow[];
    // The checks all pass: one line, the rows on demand.
    collapsed?: boolean;
};

const MergeRunningStates = ["checking", "updating", "waitingci", "merging", "queued"];
const NamesShown = 3;
const FilesShown = 5;

export function shortSha(oid: string): string {
    return (oid ?? "").slice(0, 7);
}

// plural picks key.one for 1 and key.other otherwise; both take {count}.
export function plural(t: Translate, key: string, count: number, vars?: I18nVars): string {
    return t(`${key}.${count === 1 ? "one" : "other"}`, { count, ...vars });
}

export function listNames(t: Translate, names: string[], total?: number, shown = NamesShown): string {
    const list = (names ?? []).slice(0, shown).join(", ");
    const more = Math.max(total ?? names?.length ?? 0, names?.length ?? 0) - Math.min(shown, names?.length ?? 0);
    return more > 0 ? t("review.validate.andMore", { names: list, count: more }) : list;
}

// --- checks ---

export function checkLabel(t: Translate, check: ReviewMergeCheck): string {
    return t(`review.validate.check.${check.id}`);
}

export function checkDetail(t: Translate, check: ReviewMergeCheck): string {
    const names = listNames(t, check.names ?? []);
    switch (check.code) {
        case "notopen":
            return t("review.validate.checkCode.notopen", { state: check.prstate ?? "" });
        case "draft":
            return t("review.validate.checkCode.draft");
        case "failing":
            return t("review.validate.checkCode.failing", { count: check.count ?? 0, names });
        case "running":
            return t("review.validate.checkCode.running", { count: check.count ?? 0, names });
        case "nocheck":
            return t("review.validate.checkCode.nocheck");
        case "passed":
            return check.local
                ? t("review.validate.checkCode.passedLocal", { count: check.count ?? 0, local: check.local })
                : t("review.validate.checkCode.passed", { count: check.count ?? 0 });
        case "conflicting":
            return t("review.validate.checkCode.conflicting", { base: check.base ?? "" });
        case "computing":
            return t("review.validate.checkCode.computing");
        case "blocked":
            return t("review.validate.checkCode.blocked");
        case "behind":
            return t("review.validate.checkCode.behind", { base: check.base ?? "" });
        case "unpublished":
            return plural(t, "review.validate.checkCode.unpublished", check.count ?? 0);
        case "inflight":
            return t("review.validate.checkCode.inflight");
    }
    return "";
}

function checkRowState(state: ReviewCheckState): StepState {
    switch (state) {
        case "fail":
            return "failed";
        case "pending":
            return "running";
        case "warn":
            return "needs";
    }
    return "done";
}

// blockingText says why Merge is disabled: the blocking check and its detail.
export function blockingText(t: Translate, check: ReviewMergeCheck): string {
    if (check == null) {
        return t("review.merge.checkFails");
    }
    const detail = checkDetail(t, check);
    return detail ? `${checkLabel(t, check)}: ${detail}` : checkLabel(t, check);
}

function checksStep(t: Translate, plan: ReviewMergePlan, record: ReviewMergeRecord): ValidateStep {
    const step: ValidateStep = {
        id: "checks",
        title: t("review.validate.step.checks"),
        state: "todo",
        lines: [],
        rows: [],
    };
    if (plan == null) {
        step.state = record != null ? "done" : "running";
        step.lines.push(record != null ? t("review.validate.checks.passedBefore") : t("review.validate.readingGithub"));
        return step;
    }
    step.rows = plan.checks.map((c) => {
        const detail = checkDetail(t, c);
        return { id: c.id, label: checkLabel(t, c), state: checkRowState(c.state), lines: detail ? [detail] : [] };
    });
    const problems = step.rows.filter((r) => r.state !== "done").length;
    if (step.rows.some((r) => r.state === "failed")) {
        step.state = "failed";
    } else if (step.rows.some((r) => r.state === "running")) {
        step.state = "running";
    } else if (problems > 0) {
        step.state = "needs";
    } else {
        step.state = "done";
    }
    if (problems === 0) {
        step.collapsed = true;
        step.lines.push(plural(t, "review.validate.checks.allPass", step.rows.length));
    } else {
        step.lines.push(plural(t, "review.validate.checks.problems", problems));
    }
    return step;
}

// --- merge ---

export function mergeOutcomeText(t: Translate, record: ReviewMergeRecord, baseref: string): string {
    const vars = {
        base: baseref,
        head: shortSha(record.head),
        from: shortSha(record.movedfrom),
        to: shortSha(record.movedto),
    };
    switch (record.state) {
        case "checking":
            return t("review.merge.state.checking");
        case "updating":
            return methodOf(record.method) === "rebase"
                ? t("review.merge.state.updating", { base: baseref })
                : t("review.merge.state.updatingMerge", { base: baseref });
        case "waitingci":
            return t("review.merge.state.waitingci");
        case "merging":
            return t("review.merge.state.merging");
        case "queued":
            return t("review.merge.state.queued", { base: baseref });
    }
    switch (record.code) {
        case "merged":
            return t(`review.validate.outcome.merged.${methodOf(record.method)}`, vars);
        case "queuetimeout":
            return t("review.validate.outcome.queuetimeout", { minutes: record.minutes ?? 0 });
        case "check":
            return t("review.validate.outcome.check", { reason: blockingText(t, record.blocking) });
        case "cifailed":
            return t("review.validate.outcome.cifailed", { names: listNames(t, record.names ?? []) });
        case "citimeout":
            return t("review.validate.outcome.citimeout", { minutes: record.minutes ?? 0 });
        case "reread":
        case "mergedaway":
        case "headmoved":
        case "githubheadmoved":
        case "newwarning":
        case "mergeerror":
        case "updateerror":
        case "stopped":
        case "pollerror":
        case "conflict":
        case "basemoved":
        case "rebasedblocked":
        case "queueclosed":
        case "queuestopped":
            return t(`review.validate.outcome.${record.code}`, vars);
    }
    if (record.message) {
        return record.message;
    }
    return record.state === "merged"
        ? t("review.merge.state.merged")
        : t(`review.validate.outcome.state.${record.state}`);
}

// methodOf: a record or plan made before #673 has no method, and was a rebase.
export function methodOf(method: string): ReviewMergeMethod {
    return method === "merge" || method === "squash" ? method : "rebase";
}

// methodRuleLine says what narrowed the methods the sheet offers, "" when nothing did.
export function methodRuleLine(t: Translate, plan: ReviewMergePlan, baseref: string): string {
    const methods = (plan?.methods ?? []).map((m) => t(`review.validate.method.${m}`)).join(", ");
    switch (plan?.methodrule) {
        case "queue":
            return t("review.validate.plan.rule.queue", {
                base: baseref,
                method: t(`review.validate.method.${methodOf(plan.method)}`),
            });
        case "ruleset":
            return t("review.validate.plan.rule.ruleset", { base: baseref, methods });
        case "linear":
            return t("review.validate.plan.rule.linear", { base: baseref });
    }
    if (plan?.methods?.length === 1) {
        return t("review.validate.plan.rule.only", { method: methods });
    }
    return "";
}

function mergeStep(
    t: Translate,
    plan: ReviewMergePlan,
    record: ReviewMergeRecord,
    baseref: string,
    cleanup: ReviewCleanupResult,
    picked: ReviewMergeMethod
): ValidateStep {
    const headref = plan?.headref ?? cleanup?.branch ?? "";
    const method = methodOf(record?.method ?? picked ?? plan?.method);
    const vars = { head: headref, base: baseref };
    const step: ValidateStep = {
        id: "merge",
        title: plan?.queue
            ? t("review.validate.step.merge.queue", vars)
            : t(`review.validate.step.merge.${method}`, vars),
        state: "todo",
        lines: [],
        rows: [],
    };
    if (record == null) {
        const rule = methodRuleLine(t, plan, baseref);
        if (rule) {
            step.lines.push(rule);
        }
        if (plan?.behind && !plan.queue) {
            step.lines.push(t(`review.validate.plan.behind.${method === "rebase" ? "rebase" : "merge"}`, vars));
        }
        step.lines.push(
            plan?.queue ? t("review.validate.plan.merge.queue", vars) : t(`review.validate.plan.merge.${method}`, vars)
        );
        if (plan?.headoid) {
            step.lines.push(t("review.validate.plan.bound", { oid: shortSha(plan.headoid) }));
        }
        return step;
    }
    step.lines.push(mergeOutcomeText(t, record, baseref));
    if (MergeRunningStates.includes(record.state)) {
        step.state = "running";
    } else if (record.state === "merged") {
        step.state = "done";
        if (record.head && record.head !== record.planhead) {
            step.lines.push(t("review.validate.updatedHead", { oid: shortSha(record.head) }));
        }
    } else if (record.state === "cancelled") {
        step.state = "skipped";
    } else {
        step.state = "failed";
    }
    if (record.error) {
        step.error = record.error;
    }
    const pr = cleanup?.steps?.find((s) => s.id === "pr");
    if (pr?.state === "failed") {
        step.lines.push(
            pr.code === "notmerged"
                ? t("review.validate.cleanup.prNotMerged")
                : t("review.validate.cleanup.prUnreadable")
        );
        step.error = pr.error ?? step.error;
    }
    return step;
}

// --- cleanup rows ---

function rowState(step: ReviewCleanupStepResult): StepState {
    // A folder the worktree left once git unregistered it (#716): a warning, never a failure.
    if (step?.code === "leftover" && step.state !== "planned") {
        return "needs";
    }
    switch (step?.state) {
        case "done":
            return "done";
        case "failed":
            return "failed";
        case "skipped":
            return step.code === "kept" || step.code === "inuse" ? "needs" : "skipped";
    }
    // planned: what has nothing to do is already known.
    if (step?.code && step.code !== "willremove") {
        return "skipped";
    }
    return "todo";
}

function aggregate(rows: StepRow[]): StepState {
    if (rows.length === 0) {
        return "todo";
    }
    for (const s of ["failed", "needs", "running"] as StepState[]) {
        if (rows.some((r) => r.state === s)) {
            return s;
        }
    }
    if (rows.some((r) => r.state === "todo")) {
        return "todo";
    }
    if (rows.some((r) => r.state === "done")) {
        return "done";
    }
    return "skipped";
}

// lossLines names what removing a kept worktree would lose (#672).
export function lossLines(t: Translate, loss: ReviewWorktreeLoss): string[] {
    if (loss == null) {
        return [];
    }
    const lines: string[] = [];
    if (loss.changecount > 0) {
        lines.push(
            plural(t, "review.validate.loss.files", loss.changecount, {
                names: listNames(t, loss.changes ?? [], loss.changecount, FilesShown),
            })
        );
    }
    if (loss.commitcount > 0) {
        const subjects = (loss.commits ?? []).map((c) => `${shortSha(c.sha)} ${c.subject}`);
        lines.push(
            plural(t, "review.validate.loss.commits", loss.commitcount, {
                names: listNames(t, subjects, loss.commitcount, FilesShown),
            })
        );
    }
    if (loss.commitcount < 0) {
        lines.push(t("review.validate.loss.unknownCommits"));
    }
    return lines;
}

// lossWhat names the loss in a few words ("2 files and 1 commit"); "" when nothing is known to be lost.
function lossWhat(t: Translate, loss: ReviewWorktreeLoss): string {
    const files = Math.max(loss?.changecount ?? 0, 0);
    const commits = Math.max(loss?.commitcount ?? 0, 0);
    const parts: string[] = [];
    if (files > 0) {
        parts.push(plural(t, "review.validate.loss.nFiles", files));
    }
    if (commits > 0) {
        parts.push(plural(t, "review.validate.loss.nCommits", commits));
    }
    if (parts.length === 2) {
        return t("review.validate.loss.and", { first: parts[0], second: parts[1] });
    }
    return parts[0] ?? "";
}

function lossUnknown(loss: ReviewWorktreeLoss): boolean {
    return (loss?.commitcount ?? 0) < 0;
}

// lossButtonLabel names what the destructive button loses.
export function lossButtonLabel(t: Translate, loss: ReviewWorktreeLoss): string {
    const what = lossWhat(t, loss);
    if (what) {
        return t("review.validate.loss.button", { what });
    }
    return t("review.validate.loss.buttonUnknown");
}

// keptButtonLabel is the destructive button of a kept worktree: it closes the panels still open in it first, and names
// what removing loses.
export function keptButtonLabel(t: Translate, step: ReviewCleanupStepResult): string {
    const panels = step?.panels?.length ?? 0;
    if (panels === 0) {
        return lossButtonLabel(t, step?.loss);
    }
    const what = lossWhat(t, step.loss);
    if (what) {
        return plural(t, "review.validate.panels.buttonLoss", panels, { what });
    }
    if (lossUnknown(step.loss)) {
        return plural(t, "review.validate.panels.buttonUnknown", panels);
    }
    return plural(t, "review.validate.panels.button", panels);
}

export function panelName(t: Translate, panel: ReviewCleanupPanel): string {
    const tab = panel.tab || t("review.validate.panels.untitled");
    return panel.workspace ? t("review.validate.panels.inWorkspace", { tab, workspace: panel.workspace }) : tab;
}

// panelLines says which panels still work in a kept worktree.
export function panelLines(t: Translate, panels: ReviewCleanupPanel[]): string[] {
    return (panels ?? []).map((p) =>
        p.agent
            ? t("review.validate.panels.agent", { panel: panelName(t, p) })
            : t("review.validate.panels.terminal", { panel: panelName(t, p) })
    );
}

function ignoredLine(t: Translate, loss: ReviewWorktreeLoss): string {
    if (loss == null || !(loss.ignoredcount > 0)) {
        return "";
    }
    return plural(t, "review.validate.cleanup.ignoredGone", loss.ignoredcount, {
        names: listNames(t, loss.ignored ?? [], loss.ignoredcount),
    });
}

function cleanupRowText(t: Translate, step: ReviewCleanupStepResult, branch: string, base: string): string[] {
    const vars = {
        ticket: step.ticket ?? "",
        branch: step.branch || branch,
        base: step.base || base,
        path: step.path ?? "",
    };
    const key = `review.validate.cleanup.${step.id}.${step.state === "planned" ? "plan" : "did"}.${step.code || "none"}`;
    if (step.code == null && (step.reason || step.message)) {
        return [step.reason || step.message];
    }
    const lines = [t(key, vars)];
    lines.push(...panelLines(t, step.panels));
    if (step.code === "kept") {
        lines.push(...lossLines(t, step.loss));
    }
    if (step.code === "leftover" && step.error) {
        lines.push(t("review.validate.cleanup.leftoverWhy", { error: step.error }));
    }
    if (step.id === "agent-worktree" && step.state === "done") {
        const ignored = ignoredLine(t, step.loss);
        if (ignored) {
            lines.push(ignored);
        }
    }
    return lines;
}

function cleanupRow(t: Translate, step: ReviewCleanupStepResult, branch: string, base: string): StepRow {
    return {
        id: step.id,
        label: t(`review.validate.cleanup.${step.id}.label`),
        state: rowState(step),
        lines: cleanupRowText(t, step, branch, base),
        error: step.state === "failed" ? step.error : undefined,
    };
}

function notRun(t: Translate, step: ValidateStep, record: ReviewMergeRecord): boolean {
    if (record == null || MergeRunningStates.includes(record.state) || record.state === "merged") {
        return false;
    }
    step.state = "skipped";
    step.lines = [t("review.validate.notRun")];
    step.rows = [];
    return true;
}

// settle gives a cleanup step its state: the aggregate of its rows, or, after the merge and before the cleanup
// reported, to do (running while it runs).
function settle(t: Translate, step: ValidateStep, record: ReviewMergeRecord, cleanup: ReviewCleanupResult) {
    if (record != null && cleanup == null) {
        step.state = record.cleanuprunning ? "running" : "todo";
        if (record.cleanuprunning) {
            step.lines.unshift(t("review.validate.cleaningUp"));
        }
        return;
    }
    step.state = aggregate(step.rows);
}

function stepsOf(source: ReviewCleanupStepResult[], ids: string[]): ReviewCleanupStepResult[] {
    return ids.map((id) => source.find((s) => s.id === id)).filter((s) => s != null);
}

function ticketStep(
    t: Translate,
    source: ReviewCleanupStepResult[],
    branch: string,
    base: string,
    record: ReviewMergeRecord,
    cleanup: ReviewCleanupResult
): ValidateStep {
    const step: ValidateStep = {
        id: "ticket",
        title: t("review.validate.step.ticket"),
        state: "todo",
        lines: [],
        rows: [],
    };
    if (notRun(t, step, record)) {
        return step;
    }
    step.rows = stepsOf(source, ["ticket-close", "ticket-done"]).map((s) => cleanupRow(t, s, branch, base));
    settle(t, step, record, cleanup);
    return step;
}

function cleanupStep(
    t: Translate,
    source: ReviewCleanupStepResult[],
    branch: string,
    base: string,
    record: ReviewMergeRecord,
    cleanup: ReviewCleanupResult
): ValidateStep {
    const step: ValidateStep = {
        id: "cleanup",
        title: t("review.validate.step.cleanup"),
        state: "todo",
        lines: [],
        rows: [],
    };
    if (notRun(t, step, record)) {
        return step;
    }
    const items = stepsOf(source, ["review-worktree", "agent-worktree", "local-branch", "remote-branch"]);
    step.rows = items.map((s) => cleanupRow(t, s, branch, base));
    if (cleanup == null) {
        step.lines.push(t("review.validate.cleanup.plan"));
    }
    const fetchError = source.find((s) => s.id === "pr" && s.state === "done" && s.error);
    if (fetchError) {
        step.lines.push(t("review.validate.cleanup.fetchFailed"));
        step.error = fetchError.error;
    }
    settle(t, step, record, cleanup);
    return step;
}

// otherPrText says what became of another open PR after the merge (#691): left alone, or conflicting and handed to its
// agent for a rebase, or waiting for it.
export function otherPrText(t: Translate, pr: ReviewCleanupPr, base: string): string {
    const vars = { base, name: pr.agent ?? "" };
    switch (pr.flag) {
        case "rebase-asked":
            return pr.agent ? t("review.validate.others.asked", vars) : t("review.validate.others.askedUnnamed", vars);
        case "rebase-typed":
            return pr.agent ? t("review.validate.others.typed", vars) : t("review.validate.others.typedUnnamed", vars);
        case "agent-busy":
            return pr.agent
                ? t("review.validate.others.agentBusy", vars)
                : t("review.validate.others.agentBusyUnnamed", vars);
        case "needs-agent":
            return t("review.validate.others.needsAgent", vars);
        case "needs-rebase":
            return t("review.validate.others.notAsked", vars);
        case "checking":
            return t("review.validate.others.checking", vars);
    }
    return t("review.validate.others.unaffected");
}

function otherPrRowState(pr: ReviewCleanupPr): StepState {
    switch (pr.flag) {
        case "rebase-asked":
        case "rebase-typed":
            return "done";
        case "agent-busy":
        case "needs-agent":
            return "needs";
        case "checking":
            return "skipped";
    }
    return pr.state === "failed" ? "failed" : "needs";
}

// otherPrsSummary: "3 unaffected · 1 conflicts with develop · 1 still checking".
function otherPrsSummary(t: Translate, others: ReviewCleanupStepResult, base: string): string {
    const counts: string[] = [];
    if (others.unaffected > 0) {
        counts.push(plural(t, "review.validate.others.unaffectedCount", others.unaffected));
    }
    if (others.conflicting > 0) {
        counts.push(plural(t, "review.validate.others.conflictingCount", others.conflicting, { base }));
    }
    if (others.checking > 0) {
        counts.push(plural(t, "review.validate.others.checkingCount", others.checking));
    }
    return counts.join(" · ");
}

function othersStep(
    t: Translate,
    source: ReviewCleanupStepResult[],
    base: string,
    record: ReviewMergeRecord,
    cleanup: ReviewCleanupResult
): ValidateStep {
    const step: ValidateStep = {
        id: "others",
        title: t("review.validate.step.others"),
        state: "todo",
        lines: [],
        rows: [],
    };
    if (notRun(t, step, record)) {
        return step;
    }
    const others = source.find((s) => s.id === "other-prs");
    if (cleanup == null || others == null || others.state === "planned") {
        step.lines.push(t("review.validate.others.plan", { base }));
        settle(t, step, record, cleanup);
        return step;
    }
    if (others.state === "skipped") {
        step.state = "skipped";
        step.lines.push(
            others.code === "prunconfirmed"
                ? t("review.validate.cleanup.notConfirmed")
                : t("review.validate.others.none", { base: others.base || base })
        );
        return step;
    }
    const prBase = others.base || base;
    // One row per PR the merge concerns; the unaffected ones are only counted.
    step.rows = (others.prs ?? [])
        .filter((pr) => !!pr.flag)
        .map((pr) => ({
            id: `pr-${pr.number}`,
            label: `#${pr.number} ${pr.branch}`,
            state: otherPrRowState(pr),
            lines: [otherPrText(t, pr, prBase)],
            error: pr.error,
            url: pr.url,
            startAgent: pr.flag === "needs-agent" ? pr : undefined,
        }));
    if (others.state === "failed" && (others.prs ?? []).length === 0) {
        step.state = "failed";
        step.lines.push(t("review.validate.others.listFailed"));
        step.error = others.error;
        return step;
    }
    const summary = otherPrsSummary(t, others, prBase);
    if (summary) {
        step.lines.push(summary);
    }
    const state = aggregate(step.rows);
    step.state = state === "todo" || state === "skipped" ? "done" : state;
    return step;
}

export type StepperInput = {
    plan: ReviewMergePlan;
    record: ReviewMergeRecord;
    // The cleanup this merge ran (mergeCleanup), null before it reported.
    cleanup: ReviewCleanupResult;
    headref: string;
    baseref: string;
    // The merge method picked in the sheet (#673); the plan's default when absent.
    method?: ReviewMergeMethod;
};

// buildValidateSteps is the stepper: the plan before the merge, then the merge's progress and the cleanup's outcome.
export function buildValidateSteps(t: Translate, input: StepperInput): ValidateStep[] {
    const { plan, record, cleanup, baseref } = input;
    const branch = plan?.headref ?? cleanup?.branch ?? input.headref;
    const source: ReviewCleanupStepResult[] = cleanup?.steps ?? plan?.cleanup ?? [];
    return [
        checksStep(t, plan, record),
        mergeStep(t, plan, record, baseref, cleanup, input.method),
        ticketStep(t, source, branch, baseref, record, cleanup),
        cleanupStep(t, source, branch, baseref, record, cleanup),
        othersStep(t, source, baseref, record, cleanup),
    ];
}
