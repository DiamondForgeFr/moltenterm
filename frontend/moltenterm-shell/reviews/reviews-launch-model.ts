// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Launch from the Reviews view (FR-REV-031, DS-REV-018, DS-REV-019): the words and the decisions of the launch bar,
// the cards' Launch button, the confirmation and the recipe dialog. wavesrv (pkg/molten/mission/launch*.go) runs it.

import type { TFunction } from "../i18n/i18n";
import { serverText, ServerText } from "../i18n/server-text";
import type { ReviewPr } from "./reviews-model";
import type { UpcomingBranch } from "./reviews-upcoming-model";

// must match the LaunchTarget… constants in pkg/molten/mission/launch.go
export type LaunchTargetKind = "pr" | "branch" | "trunk";
export type LaunchStateKind = "" | "starting" | "running" | "failed" | "stopped";
export type LaunchStepState = "pending" | "running" | "done" | "failed" | "stopped";
export type LaunchStepKind = "checkout" | "prepare" | "server";

// must match LaunchTarget in pkg/molten/mission/launch.go
export type LaunchTarget = {
    kind: LaunchTargetKind;
    number?: number;
    branch?: string;
    title?: string;
    headoid?: string;
};

// must match LaunchStep in pkg/molten/mission/launch.go
export type LaunchStep = {
    id: string;
    kind: LaunchStepKind;
    title?: string;
    run?: string;
    cwd?: string;
    port?: number;
    state: LaunchStepState;
    pid?: number;
    startedat?: number;
    finishedat?: number;
    error?: string;
    errortext?: ServerText;
};

// must match LaunchState in pkg/molten/mission/launch.go
export type LaunchState = {
    dir: string;
    id: string;
    target: LaunchTarget;
    servedir: string;
    worktree?: boolean;
    commit?: string;
    state: LaunchStateKind;
    steps: LaunchStep[];
    url?: string;
    previous?: string;
    stash?: string;
    startedat: number;
    readyat?: number;
    error?: string;
    errortext?: ServerText;
};

// must match LaunchRecipe in pkg/molten/mission/launch_recipe.go
export type LaunchRecipeStep = { id: string; title?: string; run: string; cwd?: string };
export type LaunchRecipeServer = { id: string; title?: string; run: string; cwd?: string; port?: number };
export type LaunchRecipe = {
    where?: "main" | "worktree";
    prepare: LaunchRecipeStep[];
    servers: LaunchRecipeServer[];
    url?: string;
};

// must match LaunchRecipeAnswer in pkg/molten/mission/launch_recipe.go
export type LaunchRecipeAnswer = {
    dir: string;
    saved?: LaunchRecipe;
    proposal?: LaunchRecipe;
    proposalfrom?: "" | "project" | "detected";
};

export type LaunchPortHolder = { port: number; pid?: number; name?: string };

// must match LaunchPlan in pkg/molten/mission/launch.go
export type LaunchPlan = {
    dir: string;
    running?: LaunchState;
    recipe?: LaunchRecipe;
    servedir: string;
    worktree?: boolean;
    branch?: string;
    commit?: string;
    dirty: string[];
    dirtycount: number;
    holders: LaunchPortHolder[];
};

export function launchTargetOfPr(pr: ReviewPr): LaunchTarget {
    return { kind: "pr", number: pr.number, branch: pr.branch, title: pr.tickettitle || pr.title, headoid: pr.headoid };
}

export function launchTargetOfBranch(branch: UpcomingBranch): LaunchTarget {
    return { kind: "branch", branch: branch.branch, title: branch.title };
}

export function launchTrunkTarget(): LaunchTarget {
    return { kind: "trunk" };
}

export function launchActive(state: LaunchState): boolean {
    return state?.state === "starting" || state?.state === "running";
}

// The launch a card shows as its own: the same PR, or the same branch.
export function launchIsOf(state: LaunchState, target: LaunchTarget): boolean {
    if (!state?.id || target == null) {
        return false;
    }
    if (target.kind === "pr") {
        return state.target.kind === "pr" && state.target.number === target.number;
    }
    if (target.kind === "branch") {
        return state.target.kind !== "trunk" && state.target.branch === target.branch;
    }
    return state.target.kind === "trunk";
}

export function launchTargetLabel(t: TFunction, target: LaunchTarget, trunk?: string): string {
    if (target.kind === "pr") {
        return t("reviews.launch.targetPr", { number: target.number });
    }
    if (target.kind === "trunk") {
        return target.branch || trunk || t("reviews.launch.trunk");
    }
    return target.branch;
}

function stripPrefix(id: string, prefix: string): string {
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

export function launchStepTitle(t: TFunction, step: LaunchStep): string {
    if (step.kind === "checkout") {
        return t("reviews.launch.step.checkout");
    }
    if (step.title) {
        return step.title;
    }
    if (step.kind === "server") {
        const name = stripPrefix(step.id, "server-");
        return step.port
            ? t("reviews.launch.step.serverPort", { name, port: step.port })
            : t("reviews.launch.step.server", { name });
    }
    const id = stripPrefix(step.id, "prepare-");
    if (id === "install") {
        return t("reviews.launch.step.install");
    }
    if (id.startsWith("migrate-")) {
        return t("reviews.launch.step.migrate", { name: id.slice("migrate-".length) });
    }
    return id;
}

export function launchStepError(step: LaunchStep): string {
    return serverText(step?.errortext, step?.error ?? "");
}

export function launchFailedStep(state: LaunchState): LaunchStep {
    return state?.steps?.find((step) => step.state === "failed") ?? null;
}

// The bar's one line: what runs, or what is starting, or what failed.
export function launchStatusText(t: TFunction, state: LaunchState, trunk?: string): string {
    const target = launchTargetLabel(t, state.target, trunk);
    switch (state.state) {
        case "starting": {
            const current = state.steps.find((step) => step.state === "running");
            return current
                ? t("reviews.launch.status.startingStep", { target, step: launchStepTitle(t, current) })
                : t("reviews.launch.status.starting", { target });
        }
        case "running":
            return t("reviews.launch.status.running", { target });
        case "failed": {
            const failed = launchFailedStep(state);
            return failed
                ? t("reviews.launch.status.failedStep", { target, step: launchStepTitle(t, failed) })
                : t("reviews.launch.status.failed", { target });
        }
        case "stopped":
            return t("reviews.launch.status.stopped", { target });
    }
    return "";
}

// Back to the trunk (FR-REV-031-AC6) is offered, never run, once the launched PR is merged.
export function launchBackOffered(state: LaunchState, mergedNumbers: readonly number[]): boolean {
    if (!state?.id || state.state === "starting" || state.target.kind !== "pr") {
        return false;
    }
    return mergedNumbers.includes(state.target.number);
}

export type PlanLine = { key: string; text: string; tone?: "warning" | "muted" };

// What the confirmation says the launch replaces, switches, loses and runs (FR-REV-031-AC2).
export function launchPlanLines(t: TFunction, plan: LaunchPlan, target: LaunchTarget, trunk?: string): PlanLine[] {
    const lines: PlanLine[] = [];
    const label = launchTargetLabel(t, target, trunk);
    if (plan.running?.id) {
        lines.push({
            key: "running",
            text: t("reviews.launch.plan.stopsRunning", { target: launchTargetLabel(t, plan.running.target, trunk) }),
            tone: "warning",
        });
    }
    for (const holder of plan.holders ?? []) {
        lines.push({
            key: `holder-${holder.port}-${holder.pid ?? 0}`,
            text: holder.pid
                ? t("reviews.launch.plan.stopsHolder", { name: holder.name || "?", pid: holder.pid, port: holder.port })
                : t("reviews.launch.plan.portBusy", { port: holder.port }),
            tone: "warning",
        });
    }
    const from = plan.branch || (plan.commit ? t("reviews.launch.plan.detachedAt", { commit: plan.commit }) : "");
    if (plan.worktree) {
        lines.push({ key: "checkout", text: t("reviews.launch.plan.worktree", { folder: plan.servedir }) });
    } else if (target.kind === "trunk") {
        lines.push({ key: "checkout", text: t("reviews.launch.plan.trunk", { folder: plan.servedir, branch: label }) });
    } else {
        lines.push({
            key: "checkout",
            text: from
                ? t("reviews.launch.plan.switch", { folder: plan.servedir, from, target: label })
                : t("reviews.launch.plan.switchFresh", { folder: plan.servedir, target: label }),
        });
    }
    const recipe = plan.recipe;
    if (recipe != null) {
        const prepare = recipe.prepare.map((step) =>
            launchStepTitle(t, { id: "prepare-" + step.id, kind: "prepare", title: step.title, state: "pending" })
        );
        const servers = recipe.servers.map((server) =>
            launchStepTitle(t, {
                id: "server-" + server.id,
                kind: "server",
                title: server.title,
                port: server.port,
                state: "pending",
            })
        );
        if (prepare.length > 0) {
            lines.push({
                key: "prepare",
                text: t("reviews.launch.plan.prepare", { steps: prepare.join(", ") }),
                tone: "muted",
            });
        }
        lines.push({
            key: "servers",
            text: t("reviews.launch.plan.servers", { servers: servers.join(", ") }),
            tone: "muted",
        });
        const url = launchRecipeUrl(recipe);
        if (url) {
            lines.push({ key: "url", text: t("reviews.launch.plan.opens", { url }), tone: "muted" });
        }
    }
    return lines;
}

export function launchRecipeUrl(recipe: LaunchRecipe): string {
    if (recipe?.url) {
        return recipe.url;
    }
    const server = recipe?.servers?.find((s) => (s.port ?? 0) > 0);
    return server ? `http://localhost:${server.port}` : "";
}

export function emptyLaunchRecipe(): LaunchRecipe {
    return { where: "main", prepare: [], servers: [{ id: "", run: "", port: undefined }], url: "" };
}

// The recipe the dialog starts from: the saved one, else the project's proposal, else an empty form.
export function launchRecipeDraft(answer: LaunchRecipeAnswer): LaunchRecipe {
    const source = answer?.saved ?? answer?.proposal;
    if (source == null) {
        return emptyLaunchRecipe();
    }
    return {
        where: source.where || "main",
        prepare: (source.prepare ?? []).map((s) => ({ ...s })),
        servers: (source.servers ?? []).map((s) => ({ ...s })),
        url: source.url ?? "",
    };
}

// The recipe dialog's first problem, worded, or "" when it can be saved; wavesrv checks the same.
export function launchRecipeProblem(t: TFunction, recipe: LaunchRecipe): string {
    const servers = recipe.servers.filter((s) => s.run.trim() !== "");
    if (servers.length === 0) {
        return t("reviews.launch.recipe.problem.noServer");
    }
    const ports = new Set<number>();
    for (const server of servers) {
        const port = server.port;
        if (port == null) {
            continue;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return t("reviews.launch.recipe.problem.port", { port: String(port) });
        }
        if (ports.has(port)) {
            return t("reviews.launch.recipe.problem.portTwice", { port });
        }
        ports.add(port);
    }
    for (const item of [...recipe.prepare, ...recipe.servers]) {
        const cwd = (item.cwd ?? "").trim();
        if (cwd.startsWith("/") || cwd.split(/[\\/]/).includes("..")) {
            return t("reviews.launch.recipe.problem.folder", { folder: cwd });
        }
    }
    const url = (recipe.url ?? "").trim();
    if (url && !/^https?:\/\//.test(url)) {
        return t("reviews.launch.recipe.problem.url");
    }
    return "";
}

export function parsePort(text: string): number {
    const trimmed = text.trim();
    if (trimmed === "") {
        return undefined;
    }
    const port = Number(trimmed);
    return Number.isFinite(port) ? port : NaN;
}

// The browser opens once per launch, and only for a launch this window started: a launch seen from another window,
// or after a restart, opens nothing (no surprise in the interface).
export function launchUrlToOpen(state: LaunchState, asked: ReadonlySet<string>, opened: ReadonlySet<string>): string {
    if (state?.state !== "running" || !state.url || !asked.has(state.id) || opened.has(state.id)) {
        return "";
    }
    return state.url;
}
