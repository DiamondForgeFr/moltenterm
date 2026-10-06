// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mission Control's CI/CD workshop (FR-MC-025), modelled on Notulia's Dev › CI: CI local, CI remote and CD tabs for the
// active workspace's project, with history, detail and logs only. The actions and summaries live in Project
// (DS-MC-012); the header links back to it.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { cn, fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { useState } from "react";
import { focusMoltentermView } from "../open-view";
import { MoltentermProjectView } from "../project/project-model";
import { openProjectOverview } from "../project/project-tab";
import { pathBaseName } from "../workspace-project";
import { AdapterSteps } from "./adapter-steps";
import { LocalCiRunner } from "./ci-local-panel";
import { BlockHeader, CdTab, Notice, RemoteCiTab } from "./cicd-panels";
import { useMissionRuns } from "./mission-client";
import { ActiveProject, MissionFrame, MissionHeader, PipelineBanner } from "./mission-frame";
import { MissionSnapshot, PipelineReport } from "./mission-model";

export const MoltentermCicdView = "molten-cicd";

const Tabs = [
    { id: "local", label: "CI local", icon: "laptop-code" },
    { id: "remote", label: "CI remote", icon: "cloud" },
    { id: "cd", label: "CD", icon: "box" },
] as const;

type TabId = (typeof Tabs)[number]["id"];

export class CicdViewModel implements ViewModel {
    viewType = MoltentermCicdView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("list-check");
    viewName = atom("CI/CD");
    noPadding = atom(true);

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
    }

    get viewComponent(): ViewComponent {
        return CicdView;
    }
}

function LocalCiTab({ project, report }: { project: ActiveProject; report: PipelineReport }) {
    const pipeline = report?.valid ? report.pipeline : null;
    const projectName = project.facts?.name ?? pathBaseName(project.dir);
    return (
        <div className="flex flex-col gap-3">
            <PipelineBanner dir={project.dir} report={report} />
            {pipeline == null ? (
                <section className="flex flex-col gap-2">
                    <BlockHeader title="Local CI" hint="the project's own checks, on this machine" />
                    <Notice text="Local CI runs the jobs the pipeline declares; connect the pipeline first." />
                </section>
            ) : (pipeline.ci?.jobs ?? []).length === 0 ? (
                <section className="flex flex-col gap-2">
                    <BlockHeader title="Local CI" hint="the project's own checks, on this machine" />
                    <Notice text="The pipeline declares no CI job (ci.jobs)." />
                </section>
            ) : (
                <LocalCiRunner dir={project.dir} projectName={projectName} />
            )}
            {report?.warnings?.length ? (
                <div className="text-[11px] text-muted">
                    {report.warnings.map((w) => (
                        <div key={w}>warning: {w}</div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

// The overview beside this panel when the tab holds it, else the Project tab (or a Project view when it is gone).
async function showProject() {
    if (await focusMoltentermView(MoltentermProjectView)) {
        return;
    }
    await openProjectOverview();
}

function ProjectLink() {
    return (
        <button
            type="button"
            onClick={() => fireAndForget(showProject)}
            className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary"
            title="Open Project: Run CI on develop, Build local, Release, Clean branches and the release summary live there"
        >
            <i className="fa fa-solid fa-diagram-project text-[10px]" />
            Project
        </button>
    );
}

function CicdView() {
    const [tab, setTab] = useState<TabId>("remote");
    return (
        <MissionFrame title="CI/CD">
            {({ project, snapshot, refresh }) => (
                <CicdContent project={project} snapshot={snapshot} refresh={refresh} tab={tab} setTab={setTab} />
            )}
        </MissionFrame>
    );
}

function CicdContent({
    project,
    snapshot,
    refresh,
    tab,
    setTab,
}: {
    project: ActiveProject;
    snapshot: MissionSnapshot;
    refresh: () => void;
    tab: TabId;
    setTab: (tab: TabId) => void;
}) {
    const runs = useMissionRuns(project.dir);
    const report = snapshot?.pipeline;
    const pipeline = report?.valid ? report.pipeline : null;
    const projectName = project.facts?.name ?? pathBaseName(project.dir);
    const steps = (section: "cilocal" | "ciremote" | "cd") => (
        <AdapterSteps dir={project.dir} projectName={projectName} pipeline={pipeline} runs={runs} section={section} />
    );
    return (
        <>
            <MissionHeader project={project} snapshot={snapshot} onRefresh={refresh}>
                <ProjectLink />
                <div role="tablist" className="flex items-center gap-0.5 rounded border border-border p-0.5">
                    {Tabs.map((t) => (
                        <button
                            key={t.id}
                            type="button"
                            role="tab"
                            aria-selected={tab === t.id}
                            onClick={() => setTab(t.id)}
                            className={cn(
                                "flex cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors",
                                tab === t.id ? "bg-hover text-primary" : "text-muted hover:text-primary"
                            )}
                        >
                            <i className={cn("fa fa-solid text-[10px]", `fa-${t.icon}`)} />
                            {t.label}
                        </button>
                    ))}
                </div>
            </MissionHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-3">
                {tab === "local" ? <LocalCiTab project={project} report={snapshot?.pipeline} /> : null}
                {tab === "local" ? steps("cilocal") : null}
                {tab === "remote" ? steps("ciremote") : null}
                {tab === "remote" ? <RemoteCiTab github={snapshot?.github} trunk={snapshot?.git?.trunk} /> : null}
                {tab === "cd" ? (
                    <CdTab git={snapshot?.git} github={snapshot?.github} pipeline={snapshot?.pipeline} runs={runs} />
                ) : null}
                {tab === "cd" ? steps("cd") : null}
            </div>
        </>
    );
}
