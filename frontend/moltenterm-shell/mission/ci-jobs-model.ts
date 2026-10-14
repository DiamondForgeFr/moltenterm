// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The CI/CD panel's Jobs tab (#637): the project's CI jobs, what each is for and when it runs, in plain words. wavesrv
// parses the files (pkg/molten/mission/cijobs.go); these rules turn its facts into sentences of the interface
// language (mc.jobs.* keys), apart from the components so they can be tested without the app. Nothing here makes a
// description up: a job's text is its file's.

import { t } from "../i18n/i18n";
import { describeCron, parseCron, WorkflowRun } from "./github";

// must match pkg/molten/mission/cijobs.go
export const MissionJobsCommand = "moltenmissionjobs";
export const MissionJobDescribeCommand = "moltenmissionjobdescribe";

export type WorkflowTrigger = {
    event: string;
    branches?: string[];
    branchesignore?: string[];
    tags?: string[];
    tagsignore?: string[];
    paths?: string[];
    pathsignore?: string[];
    types?: string[];
    crons?: string[];
    inputs?: string[];
    workflows?: string[];
};

export type CatalogueJob = {
    id: string;
    name?: string;
    line: number;
    description?: string;
    if?: string;
    needs?: string[];
    uses?: string;
};

export type CatalogueWorkflow = {
    file: string;
    path: string;
    name?: string;
    description?: string;
    triggers: WorkflowTrigger[];
    jobs: CatalogueJob[];
    error?: string;
};

export type CatalogueLocalJob = {
    name: string;
    title?: string;
    lane: string;
    order: number;
    line?: number;
    description?: string;
    run?: string;
};

export type CatalogueLocal = {
    path: string;
    jobs: CatalogueLocalJob[];
    statuses?: string;
    verifybuilds?: string[];
};

export type CiCatalogue = { dir: string; workflows: CatalogueWorkflow[]; local?: CatalogueLocal };

export type JobDescribeResult = { sent: boolean; submitted?: boolean; message: string };

// Pull request activities with a sentence of their own (mc.jobs.prType.*); others show their GitHub name.
const PullRequestTypes = [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
    "converted_to_draft",
    "closed",
    "edited",
    "labeled",
    "unlabeled",
    "assigned",
    "review_requested",
    "auto_merge_enabled",
];

// Events with a sentence of their own (mc.jobs.event.*).
const KnownEvents = [
    "workflow_call",
    "release",
    "merge_group",
    "issues",
    "issue_comment",
    "pull_request_review",
    "pull_request_review_comment",
    "create",
    "delete",
    "deployment",
    "deployment_status",
    "repository_dispatch",
    "page_build",
    "check_run",
    "check_suite",
    "status",
    "discussion",
    "fork",
    "watch",
];

// Events a condition names (mc.jobs.eventName.*).
const NamedEvents = [
    "pull_request",
    "pull_request_target",
    "push",
    "schedule",
    "workflow_dispatch",
    "workflow_call",
    "workflow_run",
    "release",
    "merge_group",
];

const Results = ["success", "failure", "cancelled", "skipped"];
const StatusFunctions = ["always", "success", "failure", "cancelled"];

function joined(items: readonly string[], key: "or" | "and"): string {
    const all = (items ?? []).filter(Boolean);
    if (all.length <= 1) {
        return all.join("");
    }
    return t(`mc.jobs.list.${key}`, { first: all.slice(0, -1).join(", "), last: all[all.length - 1] });
}

function orList(items: readonly string[]): string {
    return joined(items, "or");
}

function andList(items: readonly string[]): string {
    return joined(items, "and");
}

function pad(n: number): string {
    return String(n).padStart(2, "0");
}

// A cron in words: the shapes describeCron reads, plus intervals and days of the month. GitHub reads crons in UTC.
export function cronWords(expression: string): string {
    const parts = (expression ?? "").trim().split(/\s+/);
    const cron = parseCron(expression ?? "");
    if (cron == null || parts.length !== 5) {
        return describeCron(expression ?? "");
    }
    const [min, hour, dom, month, dow] = parts;
    const every = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];
    const restAny = dom === "*" && month === "*" && dow === "*";
    if (every(min) && hour === "*" && restAny) {
        return t("mc.jobs.cron.everyMinutes", { n: every(min) });
    }
    if (min === "*" && hour === "*" && restAny) {
        return t("mc.jobs.cron.everyMinute");
    }
    if (cron.minutes.length === 1 && hour === "*" && restAny) {
        return t("mc.jobs.cron.everyHour", { minute: cron.minutes[0] });
    }
    if (cron.minutes.length === 1 && every(hour) && restAny) {
        return t("mc.jobs.cron.everyHours", { n: every(hour), minute: cron.minutes[0] });
    }
    if (cron.minutes.length === 1 && cron.hours.length === 1 && cron.days?.length === 1 && dow === "*") {
        const at = `${pad(cron.hours[0])}:${pad(cron.minutes[0])} UTC`;
        return t(month === "*" ? "mc.jobs.cron.monthDay" : "mc.jobs.cron.someMonthsDay", { day: cron.days[0], at });
    }
    return describeCron(expression);
}

function filterWords(trigger: WorkflowTrigger): string[] {
    const out: string[] = [];
    if (trigger.paths?.length) {
        out.push(t("mc.jobs.trigger.paths", { paths: orList(trigger.paths) }));
    }
    if (trigger.pathsignore?.length) {
        out.push(t("mc.jobs.trigger.pathsIgnore", { paths: orList(trigger.pathsignore) }));
    }
    return out;
}

// side: push names the branches pushed to, pr the branches pull requests target.
function refWords(trigger: WorkflowTrigger, side: "push" | "pr" | "other"): string[] {
    const out: string[] = [];
    if (trigger.branches?.length) {
        out.push(t(`mc.jobs.ref.${side}.to`, { branches: orList(trigger.branches) }));
    }
    if (trigger.branchesignore?.length) {
        out.push(t(`mc.jobs.ref.${side}.exceptTo`, { branches: orList(trigger.branchesignore) }));
    }
    if (trigger.tags?.length) {
        out.push(t("mc.jobs.ref.tags", { tags: orList(trigger.tags) }));
    }
    if (trigger.tagsignore?.length) {
        out.push(t("mc.jobs.ref.exceptTags", { tags: orList(trigger.tagsignore) }));
    }
    return out;
}

function sentence(head: string, parts: string[]): string {
    return [head, ...parts].join(", ");
}

// One trigger as a sentence: the event, its branches or tags, the pull request activities, the path filters.
export function triggerWords(trigger: WorkflowTrigger): string {
    const event = trigger?.event ?? "";
    switch (event) {
        case "push": {
            const refs = refWords(trigger, "push");
            const head = refs.length
                ? t("mc.jobs.trigger.pushRefs", { refs: refs.join(", ") })
                : t("mc.jobs.trigger.pushAny");
            return sentence(head, filterWords(trigger));
        }
        case "pull_request":
        case "pull_request_target": {
            const refs = refWords(trigger, "pr");
            let head = refs.length
                ? t("mc.jobs.trigger.prRefs", { refs: refs.join(", ") })
                : t("mc.jobs.trigger.prAny");
            if (event === "pull_request_target") {
                head = t("mc.jobs.trigger.prTarget", { head });
            }
            const parts: string[] = [];
            if (trigger.types?.length) {
                const types = trigger.types.map((ty) =>
                    PullRequestTypes.includes(ty) ? t(`mc.jobs.prType.${ty}`) : ty
                );
                parts.push(t("mc.jobs.trigger.prTypes", { types: orList(types) }));
            }
            return sentence(head, [...parts, ...filterWords(trigger)]);
        }
        case "schedule":
            return trigger.crons?.length
                ? t("mc.jobs.trigger.scheduleCrons", { crons: trigger.crons.map(cronWords).join("; ") })
                : t("mc.jobs.trigger.schedule");
        case "workflow_dispatch":
            return trigger.inputs?.length
                ? t("mc.jobs.trigger.dispatchInputs", { inputs: andList(trigger.inputs) })
                : t("mc.jobs.trigger.dispatch");
        case "workflow_call":
            return trigger.inputs?.length
                ? t("mc.jobs.trigger.callInputs", { inputs: andList(trigger.inputs) })
                : t("mc.jobs.event.workflow_call");
        case "workflow_run": {
            const what = trigger.workflows?.length
                ? t("mc.jobs.trigger.theWorkflow", { names: orList(trigger.workflows) })
                : t("mc.jobs.trigger.anotherWorkflow");
            return trigger.types?.length
                ? t("mc.jobs.trigger.runTypes", { what, types: orList(trigger.types) })
                : t("mc.jobs.trigger.run", { what });
        }
    }
    const head = KnownEvents.includes(event) ? t(`mc.jobs.event.${event}`) : t("mc.jobs.event.other", { event });
    const parts = trigger.types?.length ? [t("mc.jobs.trigger.types", { types: orList(trigger.types) })] : [];
    return sentence(head, [...parts, ...refWords(trigger, "other"), ...filterWords(trigger)]);
}

// ---- if: conditions ----

type Expr =
    | { kind: "or" | "and"; left: Expr; right: Expr }
    | { kind: "not"; expr: Expr }
    | { kind: "cmp"; op: string; left: Expr; right: Expr }
    | { kind: "call"; name: string; args: Expr[] }
    | { kind: "lit"; value: string | number | boolean | null }
    | { kind: "ref"; path: string };

type Token = { type: "op" | "str" | "num" | "id" | "punct"; value: string };

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        const two = text.slice(i, i + 2);
        if (["&&", "||", "==", "!=", "<=", ">="].includes(two)) {
            tokens.push({ type: "op", value: two });
            i += 2;
            continue;
        }
        if (["!", "<", ">"].includes(c)) {
            tokens.push({ type: "op", value: c });
            i++;
            continue;
        }
        if ("(),".includes(c)) {
            tokens.push({ type: "punct", value: c });
            i++;
            continue;
        }
        if (c === "'") {
            let j = i + 1;
            let value = "";
            while (j < text.length) {
                if (text[j] === "'" && text[j + 1] === "'") {
                    value += "'";
                    j += 2;
                    continue;
                }
                if (text[j] === "'") {
                    break;
                }
                value += text[j];
                j++;
            }
            if (j >= text.length) {
                return null;
            }
            tokens.push({ type: "str", value });
            i = j + 1;
            continue;
        }
        const num = /^-?\d+(\.\d+)?/.exec(text.slice(i));
        if (num) {
            tokens.push({ type: "num", value: num[0] });
            i += num[0].length;
            continue;
        }
        const id = /^[A-Za-z_][\w-]*(\.(\*|[A-Za-z_][\w-]*)|\[[^\]]*\])*/.exec(text.slice(i));
        if (id) {
            tokens.push({ type: "id", value: id[0] });
            i += id[0].length;
            continue;
        }
        return null;
    }
    return tokens;
}

class Parser {
    pos = 0;
    tokens: Token[];

    constructor(tokens: Token[]) {
        this.tokens = tokens;
    }

    peek(): Token {
        return this.tokens[this.pos];
    }

    take(value?: string): Token {
        const token = this.tokens[this.pos];
        if (token == null || (value != null && token.value !== value)) {
            throw new Error("unexpected");
        }
        this.pos++;
        return token;
    }

    parseOr(): Expr {
        let left = this.parseAnd();
        while (this.peek()?.value === "||") {
            this.take();
            left = { kind: "or", left, right: this.parseAnd() };
        }
        return left;
    }

    parseAnd(): Expr {
        let left = this.parseCmp();
        while (this.peek()?.value === "&&") {
            this.take();
            left = { kind: "and", left, right: this.parseCmp() };
        }
        return left;
    }

    parseCmp(): Expr {
        const left = this.parseUnary();
        const op = this.peek();
        if (op?.type === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(op.value)) {
            this.take();
            return { kind: "cmp", op: op.value, left, right: this.parseUnary() };
        }
        return left;
    }

    parseUnary(): Expr {
        const token = this.peek();
        if (token?.value === "!") {
            this.take();
            return { kind: "not", expr: this.parseUnary() };
        }
        return this.parsePrimary();
    }

    parsePrimary(): Expr {
        const token = this.take();
        if (token.value === "(") {
            const inner = this.parseOr();
            this.take(")");
            return inner;
        }
        if (token.type === "str") {
            return { kind: "lit", value: token.value };
        }
        if (token.type === "num") {
            return { kind: "lit", value: Number(token.value) };
        }
        if (token.type !== "id") {
            throw new Error("unexpected");
        }
        if (token.value === "true" || token.value === "false") {
            return { kind: "lit", value: token.value === "true" };
        }
        if (token.value === "null") {
            return { kind: "lit", value: null };
        }
        if (this.peek()?.value === "(") {
            this.take("(");
            const args: Expr[] = [];
            while (this.peek()?.value !== ")") {
                args.push(this.parseOr());
                if (this.peek()?.value === ",") {
                    this.take(",");
                }
            }
            this.take(")");
            return { kind: "call", name: token.value.toLowerCase(), args };
        }
        return { kind: "ref", path: token.value };
    }
}

export function stripExpression(text: string): string {
    const trimmed = (text ?? "").trim();
    const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(trimmed);
    return (wrapped ? wrapped[1] : trimmed).trim();
}

function parseExpression(text: string): Expr {
    const tokens = tokenize(stripExpression(text));
    if (tokens == null || tokens.length === 0) {
        return null;
    }
    try {
        const parser = new Parser(tokens);
        const expr = parser.parseOr();
        return parser.pos === tokens.length ? expr : null;
    } catch {
        return null;
    }
}

function refText(path: string): string {
    return path.replace(/^github\./, "");
}

function litText(expr: Expr): string {
    if (expr?.kind !== "lit") {
        return null;
    }
    return expr.value == null ? t("mc.jobs.if.empty") : String(expr.value);
}

type Words = { text: string; negated: string };

function isRef(expr: Expr, path: string): boolean {
    return expr?.kind === "ref" && expr.path === path;
}

// A pair of sentences: mc.jobs.if.<key> and its negation mc.jobs.if.<key>Not.
function pair(key: string, vars?: Record<string, string | number>): Words {
    return { text: t(`mc.jobs.if.${key}`, vars), negated: t(`mc.jobs.if.${key}Not`, vars) };
}

function flip(words: Words): Words {
    return { text: words.negated, negated: words.text };
}

function eventName(value: string): string {
    return NamedEvents.includes(value)
        ? t(`mc.jobs.eventName.${value}`)
        : t("mc.jobs.eventName.other", { event: value });
}

// What a value test says, true or negated. null: no plain words for it.
function compareWords(left: Expr, op: string, right: Expr): Words {
    if (left?.kind === "lit" && right?.kind !== "lit") {
        return compareWords(right, op, left);
    }
    if (op !== "==" && op !== "!=") {
        return null;
    }
    const value = litText(right);
    const eq = op === "==";
    const pick = (words: Words): Words => (eq ? words : flip(words));
    if (isRef(left, "github.event_name") && value != null) {
        return pick(pair("event", { what: eventName(value) }));
    }
    if (isRef(left, "github.event.pull_request.draft") && right?.kind === "lit" && typeof right.value === "boolean") {
        return right.value === eq ? pair("draft") : flip(pair("draft"));
    }
    if (isRef(left, "github.event.pull_request.merged") && right?.kind === "lit" && typeof right.value === "boolean") {
        return right.value === eq ? pair("merged") : flip(pair("merged"));
    }
    if (isRef(left, "github.event.action") && value != null) {
        return pick(pair("action", { value }));
    }
    if (isRef(left, "github.ref") && value != null) {
        const branch = /^refs\/heads\/(.+)$/.exec(value)?.[1];
        const tag = /^refs\/tags\/(.+)$/.exec(value)?.[1];
        if (branch) {
            return pick(pair("branch", { name: branch }));
        }
        if (tag) {
            return pick(pair("tag", { name: tag }));
        }
    }
    if ((isRef(left, "github.ref_name") || isRef(left, "github.head_ref")) && value != null) {
        return pick(pair("refName", { value }));
    }
    if (isRef(left, "github.base_ref") && value != null) {
        return pick(pair("baseRef", { value }));
    }
    if (isRef(left, "github.event.pull_request.head.repo.full_name") && isRef(right, "github.repository")) {
        return pick(pair("sameRepo"));
    }
    if (isRef(left, "github.repository") && value != null) {
        return pick(pair("repo", { value }));
    }
    if (left?.kind !== "ref" || value == null) {
        return null;
    }
    const output = /^needs\.([\w-]+)\.outputs\.([\w-]+)$/.exec(left.path);
    if (output) {
        return pick(pair("output", { job: output[1], output: output[2], value }));
    }
    const result = /^needs\.([\w-]+)\.result$/.exec(left.path);
    if (result && Results.includes(value)) {
        return pick({
            text: t(`mc.jobs.if.result.${value}`, { job: result[1] }),
            negated: t("mc.jobs.if.resultNot", { job: result[1], value }),
        });
    }
    const input = /^(?:inputs|github\.event\.inputs)\.([\w-]+)$/.exec(left.path);
    if (input) {
        return pick(pair("input", { name: input[1], value }));
    }
    return pick(pair("equals", { ref: refText(left.path), value }));
}

function callWords(expr: Expr & { kind: "call" }): Words {
    if (StatusFunctions.includes(expr.name) && expr.args.length === 0) {
        return pair(`status.${expr.name}`);
    }
    const [a, b] = expr.args;
    const value = litText(b);
    if (expr.name === "startswith" && value != null && a?.kind === "ref") {
        if (a.path === "github.ref" && value.startsWith("refs/tags/")) {
            const prefix = value.slice("refs/tags/".length);
            return prefix ? pair("tagPrefix", { prefix }) : pair("anyTag");
        }
        if (a.path === "github.ref" && value.startsWith("refs/heads/")) {
            const prefix = value.slice("refs/heads/".length);
            return prefix ? pair("branchPrefix", { prefix }) : pair("anyBranch");
        }
        return pair("startsWith", { ref: refText(a.path), value });
    }
    if (expr.name === "contains" && value != null && a?.kind === "ref") {
        if (/^github\.event\.pull_request\.labels\.\*\.name$/.test(a.path)) {
            return pair("label", { value });
        }
        if (a.path === "github.event.head_commit.message") {
            return pair("commitMessage", { value });
        }
        return pair("contains", { ref: refText(a.path), value });
    }
    return null;
}

function refWordsOf(expr: Expr & { kind: "ref" }): Words {
    if (expr.path === "github.event.pull_request.draft") {
        return pair("draft");
    }
    if (expr.path === "github.event.pull_request.merged") {
        return pair("merged");
    }
    const input = /^(?:inputs|github\.event\.inputs)\.([\w-]+)$/.exec(expr.path);
    if (input) {
        return pair("inputSet", { name: input[1] });
    }
    return pair("set", { ref: refText(expr.path) });
}

// "not a pull request, or not a draft" is how a workflow skips draft pull requests.
function isDraftSkip(expr: Expr): boolean {
    if (expr?.kind !== "or") {
        return false;
    }
    const notPr = (e: Expr) =>
        e?.kind === "cmp" && e.op === "!=" && isRef(e.left, "github.event_name") && litText(e.right) === "pull_request";
    const notDraft = (e: Expr) =>
        (e?.kind === "not" && isRef(e.expr, "github.event.pull_request.draft")) ||
        (e?.kind === "cmp" &&
            isRef(e.left, "github.event.pull_request.draft") &&
            e.right?.kind === "lit" &&
            ((e.op === "==" && e.right.value === false) || (e.op === "!=" && e.right.value === true)));
    return (notPr(expr.left) && notDraft(expr.right)) || (notPr(expr.right) && notDraft(expr.left));
}

function group(text: string, nested: boolean): string {
    return nested ? `(${text})` : text;
}

function words(expr: Expr, nested: boolean): Words {
    switch (expr.kind) {
        case "or": {
            if (isDraftSkip(expr)) {
                return pair("draftSkip");
            }
            const l = words(expr.left, true);
            const r = words(expr.right, true);
            if (l == null || r == null) {
                return null;
            }
            return {
                text: group(t("mc.jobs.if.or", { a: l.text, b: r.text }), nested),
                negated: t("mc.jobs.if.nor", { a: l.text, b: r.text }),
            };
        }
        case "and": {
            const l = words(expr.left, true);
            const r = words(expr.right, true);
            if (l == null || r == null) {
                return null;
            }
            const text = t("mc.jobs.if.and", { a: l.text, b: r.text });
            return { text: group(text, nested), negated: t("mc.jobs.if.notAll", { text }) };
        }
        case "not": {
            const inner = words(expr.expr, true);
            return inner == null ? null : flip(inner);
        }
        case "cmp":
            return compareWords(expr.left, expr.op, expr.right);
        case "call":
            return callWords(expr);
        case "ref":
            return refWordsOf(expr);
        case "lit":
            return expr.value === true ? pair("always") : expr.value === false ? flip(pair("always")) : null;
    }
    return null;
}

// A job's `if:` in words; null when it has no plain reading (the panel then shows the expression itself).
export function conditionWords(condition: string): string {
    if (!condition?.trim()) {
        return null;
    }
    const expr = parseExpression(condition);
    if (expr == null) {
        return null;
    }
    return words(expr, false)?.text ?? null;
}

// A job's name as GitHub shows it, its expressions (a matrix value) read as their last word.
export function jobLabel(job: CatalogueJob): string {
    const name = job?.name?.trim();
    if (!name) {
        return job?.id ?? "";
    }
    return name.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, inner: string) => inner.split(".").pop() || "…");
}

// "Release tag and macOS": the jobs it waits for, by the names the workflow gives them.
export function needsWords(needs: readonly string[], jobs: readonly CatalogueJob[]): string {
    if (!needs?.length) {
        return null;
    }
    const byId = new Map((jobs ?? []).map((j) => [j.id, j] as const));
    return andList(needs.map((id) => (byId.has(id) ? jobLabel(byId.get(id)) : id)));
}

// When a local CI job runs: there is no event, only who starts the local CI.
export function localWhenWords(local: CatalogueLocal): string {
    const when = t("mc.jobs.local.when");
    if (!local?.verifybuilds?.length) {
        return when;
    }
    return t("mc.jobs.local.whenBuilds", { when, builds: andList(local.verifybuilds) });
}

export function localAfterWords(job: CatalogueLocalJob, local: CatalogueLocal): string {
    const before = (local?.jobs ?? []).filter((j) => j.lane === job.lane && j.order < job.order);
    if (before.length === 0) {
        return null;
    }
    return t("mc.jobs.local.after", { jobs: andList(before.map((j) => j.title || j.name)), lane: job.lane });
}

// The last run of a workflow among the recent ones gh listed, matched by the workflow's name.
export function lastWorkflowRun(runs: readonly WorkflowRun[], workflow: CatalogueWorkflow): WorkflowRun {
    const name = workflow?.name || workflow?.file;
    let best: WorkflowRun = null;
    for (const run of runs ?? []) {
        if (run?.workflowName !== name) {
            continue;
        }
        if (best == null || run.createdAt > best.createdAt) {
            best = run;
        }
    }
    return best;
}

export function describeOutcome(result: JobDescribeResult, agentName: string): { ok: boolean; text: string } {
    if (result == null) {
        return { ok: false, text: t("mc.jobs.outcome.unreachable") };
    }
    if (!result.sent) {
        return { ok: false, text: result.message || t("mc.jobs.outcome.nothingSent") };
    }
    if (result.submitted) {
        return { ok: true, text: t("mc.jobs.outcome.sent", { agent: agentName }) };
    }
    return { ok: true, text: t("mc.jobs.outcome.typed", { agent: agentName }) };
}
