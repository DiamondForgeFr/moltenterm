// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Settings > What MoltenTerm learned (FR-LRN-003, DS-LRN-004): what each guided workflow remembers of the developer, in
// plain words, to edit, forget or reset. The workflows' views embed the same list for their own workflow.

import { useT } from "../i18n/i18n";
import { LearnedWorkflowBody, workflowName } from "../learning/learned-section";
import { LearningWorkflows } from "../learning/learning-model";
import { useLearnedAll } from "../learning/use-learned";
import { suiteIcon } from "../suite/suite-icons";
import { PageCard } from "./settings-page";

export function LearnedCards() {
    const t = useT();
    const learned = useLearnedAll(LearningWorkflows);
    return (
        <PageCard title={t("learning.title")} hint={t("learning.intro")} icon={suiteIcon("thinking")} scope="app">
            {LearningWorkflows.map((workflow) => (
                <div key={workflow} data-testid="learning-settings-workflow" data-workflow={workflow}>
                    <h3 className="px-5 pt-3 text-12 font-medium text-primary">{workflowName(workflow, t)}</h3>
                    <LearnedWorkflowBody
                        workflow={workflow}
                        items={learned.byWorkflow[workflow] ?? []}
                        onChanged={learned.reload}
                    />
                </div>
            ))}
        </PageCard>
    );
}
