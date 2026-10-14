// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The CI/CD panel's Jobs tab (#637): the project's CI jobs, what each is for and when it runs, in plain words. wavesrv
// parses the files (pkg/molten/mission/cijobs.go); these rules turn its facts into sentences, apart from the
// components so they can be tested without the app. Nothing here makes a description up: a job's text is its file's.

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

// The UI's strings, one constant each until the translation keys (#623) land.
export const JobsText = {
    tab: "Jobs",
    remoteTitle: "Remote CI / CD",
    remoteHint: "GitHub Actions workflows, read from .github/workflows",
    localTitle: "Local CI",
    localHint: "the pipeline's ci.jobs, by lane, in order",
    noWorkflows: "The project has no GitHub Actions workflow (.github/workflows).",
    noLocal: "The pipeline declares no local CI job (ci.jobs).",
    noDescription: "No description",
    ask: "Ask the agent to describe it",
    askNoAgent: "No coding agent in this workspace: start one to ask it.",
    askPick: "Which agent writes it?",
    whenLabel: "When",
    afterLabel: "After",
    onlyIfLabel: "Only if",
    lastLabel: "Last run",
    openFile: "Open the file at this job",
    lane: "Lane",
    loading: "Reading the CI files…",
    unreadable: "Unreadable file",
    reusable: "Calls",
    runsLabel: "Runs",
    githubStatuses: "; each verdict also shows on GitHub as local-<job>",
};

const PullRequestTypeWords: Record<string, string> = {
    opened: "opened",
    synchronize: "updated with new commits",
    reopened: "reopened",
    ready_for_review: "marked ready for review",
    converted_to_draft: "returned to draft",
    closed: "closed or merged",
    edited: "edited",
    labeled: "labelled",
    unlabeled: "unlabelled",
    assigned: "assigned",
    review_requested: "given a reviewer",
    auto_merge_enabled: "set to merge automatically",
};

const EventWords: Record<string, string> = {
    push: "On every push",
    pull_request: "On pull requests",
    pull_request_target: "On pull requests, with the repository's own permissions",
    workflow_dispatch: "By hand (Run workflow on GitHub)",
    workflow_call: "When another workflow calls it",
    workflow_run: "After another workflow runs",
    schedule: "On a schedule",
    release: "On releases",
    merge_group: "In the merge queue",
    issues: "On issues",
    issue_comment: "On issue and pull request comments",
    pull_request_review: "On pull request reviews",
    pull_request_review_comment: "On pull request review comments",
    create: "When a branch or tag is created",
    delete: "When a branch or tag is deleted",
    deployment: "On deployments",
    deployment_status: "When a deployment's state changes",
    repository_dispatch: "When an outside service asks for it",
    page_build: "When GitHub Pages builds",
    check_run: "On check runs",
    check_suite: "On check suites",
    status: "When a commit status changes",
    discussion: "On discussions",
    fork: "When the repository is forked",
    watch: "When the repository is starred",
};

function list(items: readonly string[]): string {
    const quoted = (items ?? []).filter(Boolean);
    if (quoted.length <= 1) {
        return quoted.join("");
    }
    return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

function andList(items: readonly string[]): string {
    const all = (items ?? []).filter(Boolean);
    if (all.length <= 1) {
        return all.join("");
    }
    return `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
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
    if (every(min) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
        return `every ${every(min)} minutes`;
    }
    if (min === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
        return "every minute";
    }
    if (cron.minutes.length === 1 && hour === "*" && dom === "*" && month === "*" && dow === "*") {
        return `every hour at minute ${cron.minutes[0]}`;
    }
    if (cron.minutes.length === 1 && every(hour) && dom === "*" && month === "*" && dow === "*") {
        return `every ${every(hour)} hours at minute ${cron.minutes[0]} (UTC)`;
    }
    if (cron.minutes.length === 1 && cron.hours.length === 1 && cron.days?.length === 1 && dow === "*") {
        const at = `${pad(cron.hours[0])}:${pad(cron.minutes[0])} UTC`;
        return month === "*"
            ? `on day ${cron.days[0]} of every month at ${at}`
            : `on day ${cron.days[0]} of some months at ${at}`;
    }
    return describeCron(expression);
}

function filterWords(trigger: WorkflowTrigger): string[] {
    const out: string[] = [];
    if (trigger.paths?.length) {
        out.push(`only when ${list(trigger.paths)} change`);
    }
    if (trigger.pathsignore?.length) {
        out.push(`unless only ${list(trigger.pathsignore)} change`);
    }
    return out;
}

function refWords(trigger: WorkflowTrigger, to: string): string[] {
    const out: string[] = [];
    if (trigger.branches?.length) {
        out.push(`${to} ${list(trigger.branches)}`);
    }
    if (trigger.branchesignore?.length) {
        out.push(`except ${to} ${list(trigger.branchesignore)}`);
    }
    if (trigger.tags?.length) {
        out.push(`of tags ${list(trigger.tags)}`);
    }
    if (trigger.tagsignore?.length) {
        out.push(`except tags ${list(trigger.tagsignore)}`);
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
            const refs = refWords(trigger, "to");
            const head = refs.length ? `On push ${refs.join(", ")}` : "On every push";
            return sentence(head, filterWords(trigger));
        }
        case "pull_request":
        case "pull_request_target": {
            const refs = refWords(trigger, "to");
            let head = refs.length ? `On pull requests ${refs.join(", ")}` : "On pull requests";
            if (event === "pull_request_target") {
                head += ", with the repository's own permissions";
            }
            const parts: string[] = [];
            if (trigger.types?.length) {
                parts.push(`when ${list(trigger.types.map((t) => PullRequestTypeWords[t] ?? t))}`);
            }
            return sentence(head, [...parts, ...filterWords(trigger)]);
        }
        case "schedule":
            return trigger.crons?.length
                ? `On a schedule: ${trigger.crons.map(cronWords).join("; ")}`
                : "On a schedule";
        case "workflow_dispatch":
            return trigger.inputs?.length
                ? `By hand (Run workflow on GitHub), asking for ${andList(trigger.inputs)}`
                : EventWords.workflow_dispatch;
        case "workflow_call":
            return trigger.inputs?.length
                ? `When another workflow calls it, with ${andList(trigger.inputs)}`
                : EventWords.workflow_call;
        case "workflow_run": {
            const what = trigger.workflows?.length ? `the workflow ${list(trigger.workflows)}` : "another workflow";
            return trigger.types?.length ? `After ${what} is ${list(trigger.types)}` : `After ${what} runs`;
        }
    }
    const head = EventWords[event] ?? `On the ${event} event`;
    const parts = trigger.types?.length ? [`when ${list(trigger.types)}`] : [];
    return sentence(head, [...parts, ...refWords(trigger, "on"), ...filterWords(trigger)]);
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

const EventNameWords: Record<string, string> = {
    pull_request: "a pull request",
    pull_request_target: "a pull request",
    push: "a push",
    schedule: "the schedule",
    workflow_dispatch: "a run started by hand",
    workflow_call: "a call from another workflow",
    workflow_run: "another workflow's run",
    release: "a release",
    merge_group: "the merge queue",
};

const StatusWords: Record<string, string> = {
    always: "always, even when an earlier job failed or the run was cancelled",
    success: "when the jobs before it succeeded",
    failure: "when a job before it failed",
    cancelled: "when the run was cancelled",
};

const ResultWords: Record<string, string> = {
    success: "succeeded",
    failure: "failed",
    cancelled: "was cancelled",
    skipped: "was skipped",
};

function refText(path: string): string {
    return path.replace(/^github\./, "");
}

function litText(expr: Expr): string {
    if (expr?.kind !== "lit") {
        return null;
    }
    return expr.value == null ? "empty" : String(expr.value);
}

type Words = { text: string; negated?: string };

function isRef(expr: Expr, path: string): boolean {
    return expr?.kind === "ref" && expr.path === path;
}

// What a value test says, true or negated. null: no plain words for it.
function compareWords(left: Expr, op: string, right: Expr): Words {
    if (left?.kind === "lit" && right?.kind !== "lit") {
        return compareWords(right, op, left);
    }
    const value = litText(right);
    const eq = op === "==";
    if (op !== "==" && op !== "!=") {
        return null;
    }
    const pick = (yes: string, no: string): Words => (eq ? { text: yes, negated: no } : { text: no, negated: yes });
    if (isRef(left, "github.event_name") && value != null) {
        const what = EventNameWords[value] ?? `the ${value} event`;
        return pick(`on ${what}`, `not on ${what}`);
    }
    if (isRef(left, "github.event.pull_request.draft") && right?.kind === "lit" && typeof right.value === "boolean") {
        return right.value === eq
            ? { text: "the pull request is a draft", negated: "the pull request is not a draft" }
            : { text: "the pull request is not a draft", negated: "the pull request is a draft" };
    }
    if (isRef(left, "github.event.pull_request.merged") && right?.kind === "lit" && typeof right.value === "boolean") {
        return right.value === eq
            ? { text: "the pull request was merged", negated: "the pull request was not merged" }
            : { text: "the pull request was not merged", negated: "the pull request was merged" };
    }
    if (isRef(left, "github.event.action") && value != null) {
        return pick(`the event is "${value}"`, `the event is not "${value}"`);
    }
    if (isRef(left, "github.ref") && value != null) {
        const branch = /^refs\/heads\/(.+)$/.exec(value)?.[1];
        const tag = /^refs\/tags\/(.+)$/.exec(value)?.[1];
        if (branch) {
            return pick(`on the branch ${branch}`, `not on the branch ${branch}`);
        }
        if (tag) {
            return pick(`on the tag ${tag}`, `not on the tag ${tag}`);
        }
    }
    if (
        (isRef(left, "github.ref_name") || isRef(left, "github.head_ref") || isRef(left, "github.base_ref")) &&
        value != null
    ) {
        const which = left.kind === "ref" && left.path === "github.base_ref" ? "the pull request targets" : "on";
        return pick(`${which} ${value}`, `not ${which} ${value}`);
    }
    if (isRef(left, "github.event.pull_request.head.repo.full_name") && isRef(right, "github.repository")) {
        return pick("the pull request comes from this repository, not a fork", "the pull request comes from a fork");
    }
    if (isRef(left, "github.repository") && value != null) {
        return pick(`in the repository ${value} (not its forks)`, `outside the repository ${value}`);
    }
    if (left?.kind === "ref") {
        const output = /^needs\.([\w-]+)\.outputs\.([\w-]+)$/.exec(left.path);
        if (output && value != null) {
            return pick(`${output[1]}'s ${output[2]} is "${value}"`, `${output[1]}'s ${output[2]} is not "${value}"`);
        }
        const result = /^needs\.([\w-]+)\.result$/.exec(left.path);
        if (result && value != null && ResultWords[value]) {
            return pick(`${result[1]} ${ResultWords[value]}`, `${result[1]} did not end as ${value}`);
        }
        const input = /^(?:inputs|github\.event\.inputs)\.([\w-]+)$/.exec(left.path);
        if (input && value != null) {
            return pick(`the input ${input[1]} is "${value}"`, `the input ${input[1]} is not "${value}"`);
        }
        if (value != null) {
            return pick(`${refText(left.path)} is "${value}"`, `${refText(left.path)} is not "${value}"`);
        }
    }
    return null;
}

function callWords(expr: Expr & { kind: "call" }): Words {
    if (StatusWords[expr.name] && expr.args.length === 0) {
        return { text: StatusWords[expr.name], negated: `not ${StatusWords[expr.name]}` };
    }
    const [a, b] = expr.args;
    const value = litText(b);
    if (expr.name === "startswith" && value != null) {
        if (isRef(a, "github.ref") && value.startsWith("refs/tags/")) {
            const rest = value.slice("refs/tags/".length);
            const text = rest ? `on a tag starting with ${rest}` : "on a tag";
            return { text, negated: `not ${text}` };
        }
        if (isRef(a, "github.ref") && value.startsWith("refs/heads/")) {
            const rest = value.slice("refs/heads/".length);
            const text = rest ? `on a branch starting with ${rest}` : "on a branch";
            return { text, negated: `not ${text}` };
        }
        if (a?.kind === "ref") {
            return {
                text: `${refText(a.path)} starts with "${value}"`,
                negated: `${refText(a.path)} does not start with "${value}"`,
            };
        }
    }
    if (expr.name === "contains" && value != null && a?.kind === "ref") {
        if (/^github\.event\.pull_request\.labels\.\*\.name$/.test(a.path)) {
            return {
                text: `the pull request has the label ${value}`,
                negated: `the pull request does not have the label ${value}`,
            };
        }
        if (a.path === "github.event.head_commit.message") {
            return {
                text: `the commit message contains "${value}"`,
                negated: `the commit message does not contain "${value}"`,
            };
        }
        return {
            text: `${refText(a.path)} contains "${value}"`,
            negated: `${refText(a.path)} does not contain "${value}"`,
        };
    }
    return null;
}

function refWordsOf(expr: Expr & { kind: "ref" }): Words {
    if (expr.path === "github.event.pull_request.draft") {
        return { text: "the pull request is a draft", negated: "the pull request is not a draft" };
    }
    if (expr.path === "github.event.pull_request.merged") {
        return { text: "the pull request was merged", negated: "the pull request was not merged" };
    }
    const input = /^(?:inputs|github\.event\.inputs)\.([\w-]+)$/.exec(expr.path);
    if (input) {
        return { text: `the input ${input[1]} is set`, negated: `the input ${input[1]} is not set` };
    }
    return { text: `${refText(expr.path)} is set`, negated: `${refText(expr.path)} is not set` };
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

function words(expr: Expr, nested: boolean): Words {
    switch (expr.kind) {
        case "or": {
            if (isDraftSkip(expr)) {
                return { text: "except on draft pull requests", negated: "only on draft pull requests" };
            }
            const l = words(expr.left, true);
            const r = words(expr.right, true);
            if (l == null || r == null) {
                return null;
            }
            const text = `${l.text}, or ${r.text}`;
            return { text: nested ? `(${text})` : text, negated: `neither ${l.text} nor ${r.text}` };
        }
        case "and": {
            const l = words(expr.left, true);
            const r = words(expr.right, true);
            if (l == null || r == null) {
                return null;
            }
            const text = `${l.text} and ${r.text}`;
            return { text: nested ? `(${text})` : text, negated: `not (${text})` };
        }
        case "not": {
            const inner = words(expr.expr, true);
            return inner == null ? null : { text: inner.negated ?? `not ${inner.text}`, negated: inner.text };
        }
        case "cmp":
            return compareWords(expr.left, expr.op, expr.right);
        case "call":
            return callWords(expr);
        case "ref":
            return refWordsOf(expr);
        case "lit":
            return expr.value === true
                ? { text: "always", negated: "never" }
                : expr.value === false
                  ? { text: "never", negated: "always" }
                  : null;
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
    const out = words(expr, false);
    return out?.text ?? null;
}

// A job's name as GitHub shows it, its expressions (a matrix value) read as their last word.
export function jobLabel(job: CatalogueJob): string {
    const name = job?.name?.trim();
    if (!name) {
        return job?.id ?? "";
    }
    return name.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, inner: string) => inner.split(".").pop() || "…");
}

// "After Release tag and macOS": the jobs it waits for, by the names the workflow gives them.
export function needsWords(needs: readonly string[], jobs: readonly CatalogueJob[]): string {
    if (!needs?.length) {
        return null;
    }
    const byId = new Map((jobs ?? []).map((j) => [j.id, j] as const));
    return andList(needs.map((id) => (byId.has(id) ? jobLabel(byId.get(id)) : id)));
}

// When a local CI job runs: there is no event, only who starts the local CI.
export function localWhenWords(local: CatalogueLocal): string {
    const parts = ["When you or an agent run the local CI (Run CI, or molten ci run)"];
    if (local?.verifybuilds?.length) {
        parts.push(`before the ${andList(local.verifybuilds)} build`);
    }
    return parts.join(", and ");
}

export function localAfterWords(job: CatalogueLocalJob, local: CatalogueLocal): string {
    const before = (local?.jobs ?? []).filter((j) => j.lane === job.lane && j.order < job.order);
    if (before.length === 0) {
        return null;
    }
    return `${andList(before.map((j) => j.title || j.name))}, in the ${job.lane} lane (a failure stops the rest of the lane)`;
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
        return { ok: false, text: "Nothing was sent: MoltenTerm could not reach the agent." };
    }
    if (!result.sent) {
        return { ok: false, text: result.message || "Nothing was sent." };
    }
    if (result.submitted) {
        return { ok: true, text: `Sent to ${agentName}: the description will come as a change to review.` };
    }
    return {
        ok: true,
        text: `Typed in ${agentName}'s prompt after your draft there: press Enter in its terminal to send it.`,
    };
}
