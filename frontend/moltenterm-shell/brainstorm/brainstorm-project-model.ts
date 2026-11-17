// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The project card of a clear brainstorm (FR-BOSS-010 AC14, AC15, #2250), pure so that it is tested without a window:
// when the card shows and what it shows, the folder name the developer may type, the refusals, the workspace choice.
// MoltenTerm 1.0.0 offers this one way out of a clear brainstorm: the Hand to Geargrim proposal stays absent while
// DiamondForge does not offer it, with no word about it.

import type { BrainstormState, Promotion } from "./brainstorm-boot";
import type { ProjectBrief } from "./brainstorm-brief-model";
import type { BrainstormGraph } from "./brainstorm-graph-model";

// must match pkg/molten/brainstorm/project.go
export const ProjectNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ProjectRefusals = ["notempty", "inrepo", "badname", "noparent", "nobrief", "promoted", "failed"] as const;
export type ProjectRefusal = (typeof ProjectRefusals)[number];
// The window's own: the folder was made, its workspace could not be linked (Try again links it); wavesrv did not answer
// the click, so whether the project was made is not known (the card offers to look at the folder and to preview again).
export const WindowFailures = ["link", "unknown"] as const;
export type ProjectFailure = ProjectRefusal | (typeof WindowFailures)[number];

export type ProjectPreview = {
    parent: string;
    name: string;
    path?: string;
    exists?: boolean;
    docs: string;
    refusal?: string;
};

export type ProjectResult = {
    state: BrainstormState;
    preview: ProjectPreview;
    dir?: string;
    stale?: boolean;
    error?: string;
};

// What the card is: absent, waiting for his conclusion (a project proposal came first), ready with its brief, or done.
export type ProjectCard =
    | { kind: "none" }
    | { kind: "waiting" }
    | { kind: "ready"; brief: ProjectBrief }
    | { kind: "done"; brief: ProjectBrief; promotion: Promotion };

// A project proposal of his on the graph, not set aside.
export function hasProjectProposal(graph: BrainstormGraph): boolean {
    return (graph?.nodes ?? []).some((n) => n.kind === "proposal" && n.action === "project" && n.status !== "aside");
}

// The card follows the open brainstorm: its project once made; else his project proposal, ready once he concluded and
// waiting for it before. A brief alone shows no card: the proposal is his, and set aside it hides the card.
export function projectCardOf(state: BrainstormState): ProjectCard {
    if (state?.open !== true || state.brainstorm == null) {
        return { kind: "none" };
    }
    const promotion = state.brainstorm.promotedto;
    if (promotion?.dir) {
        return { kind: "done", brief: state.brief, promotion };
    }
    if (!hasProjectProposal(state.graph)) {
        return { kind: "none" };
    }
    return state.brief != null ? { kind: "ready", brief: state.brief } : { kind: "waiting" };
}

// DiamondForge offers the hand-off of a brief to Geargrim (AC14): false in MoltenTerm 1.0.0, so nothing of it shows.
export function geargrimOffered(state: BrainstormState): boolean {
    return state?.geargrim === true;
}

// The folder name as the developer types it: "" when wavesrv will take it, else why not.
export function nameProblem(name: string): "" | "badname" {
    const clean = (name ?? "").trim();
    return ProjectNamePattern.test(clean) && !clean.endsWith(".") ? "" : "badname";
}

// The key of the one sentence a refusal says; an unknown code says that it did not work.
export function refusalKey(code: string): string {
    const known =
        (ProjectRefusals as readonly string[]).includes(code) || (WindowFailures as readonly string[]).includes(code);
    return `boss.brainstorm.project.refused.${known ? code : "failed"}`;
}

// The workspace the project goes to: a new one named after it, or one the developer has, with the folder it is linked
// to now ("" for none).
export type WorkspaceChoice = { kind: "new" } | { kind: "existing"; id: string };
export type WorkspaceOption = { id: string; name: string; colour?: string; project?: string };

// The folder an existing workspace's link moves away from (AC15): linking the project replaces it, and the card says so.
// "" when the workspace has no project yet, or is a new one.
export function replacedProject(choice: WorkspaceChoice, options: WorkspaceOption[], dir: string): string {
    if (choice?.kind !== "existing") {
        return "";
    }
    const current = (options ?? []).find((o) => o.id === choice.id)?.project ?? "";
    return current !== "" && current !== dir ? current : "";
}

// What the click sends of the preview the developer saw: wavesrv acts only on that path (AC-2).
export function expectOf(preview: ProjectPreview): { path: string; exists: boolean } {
    return { path: preview?.path ?? "", exists: preview?.exists === true };
}

// The choice still standing against the workspaces there are: an existing one that is gone is a new one again.
export function choiceAmong(choice: WorkspaceChoice, options: WorkspaceOption[]): WorkspaceChoice {
    if (choice?.kind !== "existing") {
        return { kind: "new" };
    }
    return (options ?? []).some((o) => o.id === choice.id) ? choice : { kind: "new" };
}

// The parent and name a request carries: "" lets wavesrv take boss:projectsdir and the brief's slug.
export function projectRequest(parent: string, name: string, slug: string): { parent?: string; name?: string } {
    const rtn: { parent?: string; name?: string } = {};
    if ((parent ?? "").trim() !== "") {
        rtn.parent = parent.trim();
    }
    const typed = (name ?? "").trim();
    if (typed !== "" && typed !== slug) {
        rtn.name = typed;
    }
    return rtn;
}

// The click may go: a preview with a path and no refusal, a name that holds, and nothing running.
export function canCreate(preview: ProjectPreview, name: string, busy: boolean): boolean {
    if (busy || preview == null || preview.refusal || !preview.path) {
        return false;
    }
    return name.trim() === "" || nameProblem(name) === "";
}
