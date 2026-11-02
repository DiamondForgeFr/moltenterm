// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The setup panel of the pipeline setup's tab (FR-MC-038, #1150): the stepper, with "Ask for help" under its title;
// the screens it hosts ask the agent through the tab's askAgent (pipeline-tab-context.ts). The tab is closed through the
// Review tab's close path (it asks first when an agent works in the terminal);
// the answers are saved per project by wavesrv as they change, so the setup reopens where it was left.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { atom, useAtomValue } from "jotai";
import { lazy, Suspense } from "react";
import { EmptyState } from "../empty-state";
import { useT } from "../i18n/i18n";
import { closeThisTab } from "../review/review-tab-close";
import { pathBaseName } from "../workspace-project";
import { tAtom } from "./mission-i18n";
import { askPipelineAgent } from "./pipeline-agent";
import { PipelineHelp } from "./pipeline-agent-ui";
import { PipelineTabContext, PipelineTabValue } from "./pipeline-tab-context";
import {
    MoltentermPipelineView,
    PipelinePanelMetaKey,
    PipelineTabIcon,
    readPipelineTarget,
} from "./pipeline-tab-model";

export { MoltentermPipelineView };

// The stepper loads with the first setup panel, out of the entry every tab view evaluates (NFR-PERF-003).
const ReleaseSetup = lazy(() => import("./release-setup").then((m) => ({ default: m.ReleaseSetup })));

export class PipelineViewModel implements ViewModel {
    viewType = MoltentermPipelineView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom(PipelineTabIcon);
    viewName = tAtom("pipelineTab.viewName");
    noPadding = atom(true);

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
    }

    get viewComponent(): ViewComponent {
        return PipelineView;
    }
}

function PipelineView({ model }: ViewComponentProps<PipelineViewModel>) {
    const t = useT();
    const block = useAtomValue(getWaveObjectAtom<Block>(makeORef("block", model.blockId)));
    const target = readPipelineTarget(block?.meta?.[PipelinePanelMetaKey]);
    if (target == null) {
        return (
            <EmptyState
                icon={PipelineTabIcon}
                title={t("pipelineTab.noProject")}
                hint={t("pipelineTab.noProjectHint")}
            />
        );
    }
    const projectName = target.project || pathBaseName(target.dir);
    const tab: PipelineTabValue = {
        dir: target.dir,
        project: projectName,
        panelBlockId: model.blockId,
        askAgent: (req) => askPipelineAgent(target.dir, projectName, model.blockId, req),
    };
    return (
        <PipelineTabContext.Provider value={tab}>
            <Suspense fallback={null}>
                <ReleaseSetup
                    key={target.dir}
                    dir={target.dir}
                    projectName={projectName}
                    openAt={target.openat}
                    onClose={closeThisTab}
                    onWritten={() => {}}
                    aside={<PipelineHelp />}
                />
            </Suspense>
        </PipelineTabContext.Provider>
    );
}
