// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mission Control's CI/CD panel (FR-MC-002), modelled on Notulia's Dev › CI: CI local, CI remote and CD tabs for the
// active workspace's project.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { cn } from "@/util/util";
import { atom } from "jotai";
import { useState } from "react";
import { BlockHeader, CdTab, Notice, RemoteCiTab } from "./cicd-panels";
import { ActiveProject, MissionFrame, MissionHeader, PipelineBanner } from "./mission-frame";

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

function LocalCiTab({ project }: { project: ActiveProject }) {
    return (
        <div className="flex flex-col gap-3">
            <PipelineBanner dir={project.dir} facts={project.facts} />
            <section className="flex flex-col gap-2">
                <BlockHeader title="Local runs" hint="the project's own checks, on this machine" />
                <Notice
                    text={
                        project.facts?.hasPipeline
                            ? "The pipeline is ready. Running its local CI from here, with live logs and the last 20 runs, is coming next."
                            : "Local CI runs the jobs the pipeline declares; create the pipeline first."
                    }
                />
            </section>
        </div>
    );
}

function CicdView() {
    const [tab, setTab] = useState<TabId>("remote");
    return (
        <MissionFrame title="CI/CD">
            {({ project, snapshot, refresh }) => (
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
                        {tab === "local" ? <LocalCiTab project={project} /> : null}
                        {tab === "remote" ? (
                            <RemoteCiTab github={snapshot?.github} trunk={snapshot?.git?.trunk} />
                        ) : null}
                        {tab === "cd" ? <CdTab git={snapshot?.git} github={snapshot?.github} /> : null}
                    </div>
                </>
            )}
        </MissionFrame>
    );
}
