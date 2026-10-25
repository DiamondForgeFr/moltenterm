// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The deployment pipeline setup stepper (FR-MC-038, DS-MC-030): its four steps, step 1's survey of the repository and
// the answers kept per project between openings. Pure functions, tested without the app.

import type { SetupChannel, SetupKind, SetupOptions, SetupSource } from "./release-setup-model";

export type StepperStep = "detect" | "understand" | "prepare" | "template";
export const StepperSteps: StepperStep[] = ["detect", "understand", "prepare", "template"];

// must match AppType* in pkg/molten/pipelinesetup/survey.go
export type SetupAppType = "desktop" | "cli" | "web" | "library" | "other";
export const AppTypes: SetupAppType[] = ["desktop", "cli", "web", "library", "other"];

export type SetupPath = "analyse" | "describe";

// must match SurveyAnswer in pkg/molten/pipelinesetup/survey.go
export type SetupSurvey = {
    apptype: SetupAppType;
    apptypeevidence: SetupSource[];
    kind: SetupKind;
    tags: {
        read: boolean;
        prefix: string;
        count: number;
        first?: string;
        last?: string;
        pre?: number;
        lastpublic?: string;
        lastmerge?: boolean;
    };
    releases: { ongithub: boolean; read: boolean; error?: string; count: number; last?: string };
    publish: { file: string; tags: string[]; ships: string[] }[];
    changelogs: { path: string; sections: number; last?: string }[];
    pipeline: "none" | "invalid" | "norelease" | "partial" | "complete";
    missing: SetupChannel[];
    ships: boolean;
    recommended: SetupPath;
    base: string;
    answers?: SetupAnswers;
};

// must match Answers in pkg/molten/pipelinesetup/answers.go
export type SetupAnswers = {
    base: string;
    step?: StepperStep;
    apptype?: SetupAppType;
    path?: SetupPath;
    touched?: boolean;
    options?: SetupOptions;
    // Step 2a's answers to the points of the existing pipeline (#1101).
    points?: Record<string, string>;
};

// A web app or a SaaS is deployed (the saas template); every other type ships versions (pipelinesetup.KindOfAppType).
export function kindOfAppType(type: SetupAppType): SetupKind {
    return type === "web" ? "saas" : "on-premise";
}

export function stepIndex(step: StepperStep): number {
    return StepperSteps.indexOf(step);
}

// A done step reopens; the next one opens once the current step's inputs exist. Templates come with #1105.
export function stepReachable(step: StepperStep, current: StepperStep, ready: boolean): boolean {
    if (step === "template") {
        return false;
    }
    const i = stepIndex(step);
    const at = stepIndex(current);
    return i <= at || (ready && i === at + 1);
}

// The footer's primary button names the next step, never a bare "Next"; "" on the last step that writes.
export function nextLabelKey(step: StepperStep, path: SetupPath): string {
    if (step === "detect") {
        return path === "describe" ? "mc.setup.stepper.nextDescribe" : "mc.setup.stepper.nextDraw";
    }
    if (step === "understand") {
        return "mc.setup.stepper.nextPrepare";
    }
    return "";
}

// The step a saved answer resumes at: only one the stepper can show without new inputs.
export function resumeStep(answers: SetupAnswers): StepperStep {
    const step = answers?.step;
    if (step === "understand" || step === "prepare") {
        return step;
    }
    return "detect";
}

export type SurveyRow = {
    key: string;
    state: "ok" | "half" | "none" | "warn";
    labelKey: string;
    vars?: Record<string, string | number>;
    count?: number;
    source?: string;
};

// What the repository shows of a pipeline, one row per kind of evidence, as step 1 lists them.
export function surveyRows(survey: SetupSurvey, ref: string): SurveyRow[] {
    const rows: SurveyRow[] = [];
    const tags = survey.tags;
    if (!tags.read) {
        rows.push({ key: "tags", state: "warn", labelKey: "mc.setup.detect.tagsUnread" });
    } else if (tags.count > 0) {
        rows.push({
            key: "tags",
            state: "ok",
            labelKey: "mc.setup.detect.tags",
            count: tags.count,
            vars: { last: tags.last },
            source: tags.count > 1 ? `git tag · ${tags.first} → ${tags.last}` : `git tag · ${tags.last}`,
        });
    } else {
        rows.push({ key: "tags", state: "none", labelKey: "mc.setup.detect.noTags", vars: { prefix: tags.prefix } });
    }
    const rel = survey.releases;
    if (rel.ongithub && !rel.read) {
        rows.push({
            key: "releases",
            state: "warn",
            labelKey: "mc.setup.detect.releasesUnread",
            source: rel.error || "gh release list",
        });
    } else if (rel.ongithub && rel.count > 0) {
        rows.push({
            key: "releases",
            state: "ok",
            labelKey: "mc.setup.detect.releases",
            count: rel.count,
            vars: { last: rel.last },
            source: "gh release list",
        });
    } else if (rel.ongithub) {
        rows.push({
            key: "releases",
            state: "none",
            labelKey: "mc.setup.detect.noReleases",
            source: "gh release list",
        });
    }
    if (survey.publish.length > 0) {
        for (const wf of survey.publish) {
            const ships = wf.ships.length > 0 ? ` · ${wf.ships.join(", ")}` : "";
            rows.push({
                key: `publish/${wf.file}`,
                state: "ok",
                labelKey: "mc.setup.detect.publish",
                source: `${wf.file} · tags ${wf.tags.join(", ")}${ships}`,
            });
        }
    } else {
        rows.push({ key: "publish", state: "none", labelKey: "mc.setup.detect.noPublish" });
    }
    const dated = survey.changelogs.filter((c) => c.sections > 0);
    if (dated.length > 0) {
        rows.push({
            key: "changelogs",
            state: "ok",
            labelKey: "mc.setup.detect.changelogs",
            count: dated.length,
            source: dated.map((c) => c.path).join(", "),
        });
    } else if (survey.changelogs.length > 0) {
        rows.push({
            key: "changelogs",
            state: "none",
            labelKey: "mc.setup.detect.changelogsUndated",
            source: survey.changelogs.map((c) => c.path).join(", "),
        });
    } else {
        rows.push({ key: "changelogs", state: "none", labelKey: "mc.setup.detect.noChangelog" });
    }
    const pipelineState: Record<SetupSurvey["pipeline"], SurveyRow["state"]> = {
        none: "none",
        invalid: "warn",
        norelease: "half",
        partial: "half",
        complete: "ok",
    };
    rows.push({
        key: "pipeline",
        state: pipelineState[survey.pipeline],
        labelKey: `mc.setup.detect.pipeline.${survey.pipeline}`,
        source: ref ? `.molten/project.json · ${ref}` : ".molten/project.json",
    });
    return rows;
}
