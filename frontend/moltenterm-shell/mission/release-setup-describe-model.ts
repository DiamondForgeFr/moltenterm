// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 2b of the pipeline setup (FR-MC-041): what the developer's description turns into, as pure functions tested
// without the app. The template itself stays in wavesrv (pkg/molten/pipelinesetup/describe.go).

import type { SetupDraft, SetupOptions, SetupRcAnswer } from "./release-setup-model";

export type DescribeFrom = "standard" | "model" | "words";

// must match ModelProject in pkg/molten/pipelinesetup/describe.go
export type SetupModel = { dir: string; name: string; ref: string; options: SetupOptions };

// must match DescribeTargets in pkg/molten/pipelinesetup/describe.go
export const DescribeTargets = ["npm", "githubrelease"] as const;
export type DescribeTarget = (typeof DescribeTargets)[number];

export const RcAnswers: SetupRcAnswer[] = ["none", "published", "internal"];

export type TargetRow = {
    id: DescribeTarget;
    on: boolean;
    // The workflow that already publishes it on the tag; else whether the setup proposes one.
    publishedBy?: string;
    proposed: boolean;
};

// The targets this project can be published to: npm for a public package, a GitHub Release when origin is on GitHub.
export function availableTargets(draft: SetupDraft): DescribeTarget[] {
    const facts = draft.facts;
    return DescribeTargets.filter((id) =>
        id === "npm" ? (facts.targets ?? []).some((t) => t.id === "npm") : facts.ongithub
    );
}

// The questions' defaults on the first opening of 2b: the project's branches, every target it can reach, and its
// candidates published when something publishes them.
export function describeDefaults(draft: SetupDraft, options: SetupOptions): SetupOptions {
    const branches = draft.facts.branches;
    const publish = availableTargets(draft);
    return {
        ...options,
        kind: "on-premise",
        trunk: options.trunk || branches.trunk,
        release: options.release || branches.release,
        rc: options.rc ?? (publish.length > 0 ? "published" : "internal"),
        publish: options.publish ?? publish,
    };
}

// Back on path 2a: the description no longer applies.
export function undescribed(options: SetupOptions): SetupOptions {
    const { trunk, release, rc, publish, ...rest } = options;
    return rest;
}

// Path 2b asks the questions; a web app keeps the deploy choices of the SaaS template instead.
export function describes(path: string, appType: string): boolean {
    return path === "describe" && appType !== "web";
}

// The rc answer sets the channels the same way the backend does (applyDescription), so the step reads right before
// the draft comes back.
export function withRc(options: SetupOptions, rc: SetupRcAnswer): SetupOptions {
    return { ...options, rc, channels: rc === "none" ? ["public"] : ["rc", "public"] };
}

export function sameBranch(options: SetupOptions): boolean {
    return options.trunk != null && options.trunk === options.release;
}

export function targetRows(draft: SetupDraft, options: SetupOptions): TargetRow[] {
    const proposed = new Set((draft.files ?? []).flatMap((f) => f.targets));
    const proposedFiles = new Set((draft.files ?? []).map((f) => f.path.split("/").pop()));
    const tagWorkflows = (draft.tagworkflows?.public ?? []).map((w) => w.file).filter((f) => !proposedFiles.has(f));
    return availableTargets(draft).map((id) => {
        const by = (draft.facts.workflows ?? []).find(
            (w) => tagWorkflows.includes(w.file) && (w.ships ?? []).includes(id)
        );
        return {
            id,
            on: (options.publish ?? []).includes(id),
            publishedBy: by?.file,
            proposed: proposed.has(id),
        };
    });
}

export function toggledTarget(options: SetupOptions, id: string, on: boolean): SetupOptions {
    const rest = (options.publish ?? []).filter((t) => t !== id);
    return { ...options, publish: on ? [...rest, id] : rest };
}

// The branch names the two questions offer: the repository's, with the current answers first.
export function branchChoices(draft: SetupDraft, options: SetupOptions): string[] {
    const names = [options.trunk, options.release, ...(draft.branchnames ?? [])].filter((n) => !!n);
    return [...new Set(names)];
}
