// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mission Control's CI/CD panel (FR-MC-002), modelled on Notulia's Dev › CI: CI local, CI remote and CD tabs for the
// active workspace's project.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { cn } from "@/util/util";
import { atom } from "jotai";
import { useState } from "react";
import { BlockHeader, CdTab, Notice, RemoteCiTab } from "./cicd-panels";
import { useMissionRuns } from "./mission-client";
import { ActiveProject, MissionFrame, MissionHeader, PipelineBanner } from "./mission-frame";
import { jobsByLane, MissionSnapshot, PipelineReport } from "./mission-model";

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
    const lanes = jobsByLane(pipeline);
    return (
        <div className="flex flex-col gap-3">
            <PipelineBanner dir={project.dir} report={report} />
            <section className="flex flex-col gap-2">
                <BlockHeader title="Local CI" hint="the project's own checks, on this machine" />
                {pipeline == null ? (
                    <Notice text="Local CI runs the jobs the pipeline declares; connect the pipeline first." />
                ) : lanes.length === 0 ? (
                    <Notice text="The pipeline declares no CI job (ci.jobs)." />
                ) : (
                    <>
                        <div className="grid gap-2 @2xl:grid-cols-2">
                            {lanes.map((lane) => (
                                <div key={lane.lane} className="overflow-hidden rounded border border-border">
                                    <div className="border-b border-border bg-hover px-3 py-1 text-[11px] tracking-wide text-muted uppercase">
                                        lane {lane.lane}
                                    </div>
                                    {lane.jobs.map((job) => (
                                        <div
                                            key={job.name}
                                            className="flex flex-col border-b border-border px-3 py-1.5 last:border-b-0"
                                        >
                                            <span className="text-sm font-medium">{job.title || job.name}</span>
                                            <code className="truncate text-[11px] text-muted" title={job.run}>
                                                {job.cwd ? `${job.cwd}$ ` : ""}
                                                {job.run}
                                            </code>
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                        <Notice text="Running the local CI from here, with live logs and the last 20 runs, is coming next." />
                    </>
                )}
                {report?.warnings?.length ? (
                    <div className="text-[11px] text-muted">
                        {report.warnings.map((w) => (
                            <div key={w}>warning: {w}</div>
                        ))}
                    </div>
                ) : null}
            </section>
        </div>
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
    return (
        <>
            <MissionHeader project={project} snapshot={snapshot} onRefresh={refresh}>
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
            <div className="min-h-0 flex-1 overflow-auto p-3">
                {tab === "local" ? <LocalCiTab project={project} report={snapshot?.pipeline} /> : null}
                {tab === "remote" ? <RemoteCiTab github={snapshot?.github} trunk={snapshot?.git?.trunk} /> : null}
                {tab === "cd" ? (
                    <CdTab git={snapshot?.git} github={snapshot?.github} pipeline={snapshot?.pipeline} runs={runs} />
                ) : null}
            </div>
        </>
    );
}
