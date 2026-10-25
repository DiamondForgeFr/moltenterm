// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 4 of the pipeline setup (FR-MC-042): a pipeline saved as a template on this computer, and the template offered
// at step 2b of a later setup. Pure functions, tested without the app; the files live in wavesrv
// (pkg/molten/pipelinesetup/templates.go).

import { targetRows } from "./release-setup-describe-model";
import type { ManualStep, SetupDraft, SetupOptions, SetupRcAnswer } from "./release-setup-model";
import type { SetupAppType } from "./release-setup-stepper";

// must match TemplateFlow in pkg/molten/pipelinesetup/templates.go
export type SetupTemplateFlow = {
    branchmodel: string;
    single: boolean;
    release?: string;
    merge: string;
    tagprefix: string;
    rcformat: string;
    rc: SetupRcAnswer;
    notes: boolean;
    syncback: boolean;
    milestone: boolean;
    publish: string[];
    manual: ManualStep[];
};

// must match PipelineTemplate in pkg/molten/pipelinesetup/templates.go
export type SetupTemplate = {
    id: string;
    name: string;
    apptype: SetupAppType;
    from: string;
    savedat: number;
    flow: SetupTemplateFlow;
};

// must match Need* in pkg/molten/pipelinesetup/templates.go
export type SetupTemplateNeed = {
    code: "type" | "branches" | "protected" | "target" | "workflow";
    ok: boolean;
    target?: string;
    value?: string;
};

// must match TemplateFit in pkg/molten/pipelinesetup/templates.go
export type SetupTemplateFit = {
    template: SetupTemplate;
    needs: SetupTemplateNeed[];
    met: number;
    total: number;
    sametype: boolean;
    options: SetupOptions;
};

export type TextOf = { key: string; vars?: Record<string, string | number> };

// A web or SaaS pipeline deploys instead of shipping versions: templates hold the release chain only for now.
export function canSaveTemplate(draft: SetupDraft, options: SetupOptions): boolean {
    return draft != null && options != null && options.kind !== "saas" && (draft.errors ?? []).length === 0;
}

export function releaseOf(draft: SetupDraft, options: SetupOptions): string {
    return options?.release || draft?.facts?.branches?.release || "";
}

export function trunkOf(draft: SetupDraft, options: SetupOptions): string {
    return options?.trunk || draft?.facts?.branches?.trunk || "";
}

export function singleBranch(draft: SetupDraft, options: SetupOptions): boolean {
    return options?.branchmodel === "single" || trunkOf(draft, options) === releaseOf(draft, options);
}

// The release candidate answer the pipeline stands for: step 2b says it; otherwise a candidate whose tag starts a
// workflow is published (as the backend infers it).
export function rcOf(draft: SetupDraft, options: SetupOptions): SetupRcAnswer {
    if (options?.rc != null) {
        return options.rc;
    }
    if (!(options?.channels ?? []).includes("rc")) {
        return "none";
    }
    return (draft?.tagworkflows?.rc ?? []).length > 0 ? "published" : "internal";
}

// Where the versions are published: step 2b's answer, else the targets a workflow already publishes on the tag.
export function publishOf(draft: SetupDraft, options: SetupOptions): string[] {
    if (options?.publish != null) {
        return options.publish;
    }
    return targetRows(draft, options)
        .filter((r) => r.publishedBy)
        .map((r) => r.id);
}

// The flow in a few words, the proposed name's second half.
export function flowText(single: boolean, branchmodel: string, release: string): TextOf {
    if (single) {
        return { key: "mc.setup.template.flow.single" };
    }
    if (branchmodel === "rcpr") {
        return { key: "mc.setup.template.flow.rcpr", vars: { release } };
    }
    return { key: "mc.setup.template.flow.promote", vars: { release } };
}

export function defaultNameParts(
    draft: SetupDraft,
    options: SetupOptions,
    appType: SetupAppType
): {
    type: string;
    flow: TextOf;
} {
    return {
        type: `mc.setup.appType.${appType ?? "other"}Short`,
        flow: flowText(singleBranch(draft, options), options?.branchmodel, releaseOf(draft, options)),
    };
}

// What belongs to this project: a blank the next project fills with its own.
export function templateBlanks(draft: SetupDraft, options: SetupOptions): TextOf[] {
    const rtn: TextOf[] = [{ key: "mc.setup.template.blank.trunk", vars: { value: trunkOf(draft, options) } }];
    if (!singleBranch(draft, options)) {
        rtn.push({ key: "mc.setup.template.blank.published", vars: { value: releaseOf(draft, options) } });
    }
    rtn.push({ key: "mc.setup.template.blank.changelogs", vars: { n: (options?.changelogs ?? []).length } });
    rtn.push({ key: "mc.setup.template.blank.versionFiles" });
    if ((options?.ciworkflows ?? []).length > 0) {
        rtn.push({ key: "mc.setup.template.blank.ci", vars: { n: options.ciworkflows.length } });
    }
    rtn.push({ key: "mc.setup.template.blank.notesPath" });
    rtn.push({ key: "mc.setup.template.blank.publishWorkflow" });
    return rtn;
}

// A template's summary, as its card says it: the flow, the candidates, where it publishes, its hand steps.
export function flowSummary(flow: SetupTemplateFlow): TextOf[] {
    const rtn: TextOf[] = [flowText(flow.single, flow.branchmodel, flow.release ?? "")];
    rtn.push({ key: `mc.setup.template.rc.${flow.rc}` });
    if (flow.publish.length > 0) {
        rtn.push({ key: "mc.setup.template.publishes", vars: { targets: flow.publish.join(",") } });
    }
    if (flow.manual.length > 0) {
        rtn.push({ key: "mc.setup.template.hand", vars: { count: flow.manual.length } });
    }
    return rtn;
}

// The flow the save would keep, for step 4's summary before it is saved.
export function flowToSave(
    draft: SetupDraft,
    options: SetupOptions,
    keepManual: boolean,
    keepPublish: boolean
): SetupTemplateFlow {
    const single = singleBranch(draft, options);
    return {
        branchmodel: single ? "single" : options.branchmodel,
        single,
        release: single ? undefined : releaseOf(draft, options),
        merge: options.merge,
        tagprefix: options.tagprefix,
        rcformat: options.rcformat,
        rc: rcOf(draft, options),
        notes: options.notes,
        syncback: single ? false : options.syncback,
        milestone: options.milestone,
        publish: keepPublish ? publishOf(draft, options) : [],
        manual: keepManual ? (options.manual ?? []) : [],
    };
}

// The check's sentence: met, or what happens without it.
export function needText(need: SetupTemplateNeed): TextOf {
    const state = need.ok ? "Ok" : "Missing";
    return {
        key: `mc.setup.template.need.${need.code}${state}`,
        vars: { value: need.value ?? "", target: need.target ?? "" },
    };
}

// The templates the picker shows: those of this type first (the backend's order kept), the others after.
export function orderedFits(fits: SetupTemplateFit[]): SetupTemplateFit[] {
    if (fits == null) {
        return null;
    }
    return [...fits.filter((f) => f.sametype), ...fits.filter((f) => !f.sametype)];
}
