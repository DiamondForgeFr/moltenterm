// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agent's model and effort in the header (#549), two click targets (#573): the model opens the command panel's
// Model choice, the effort its Effort choice, each under what was clicked. Only what the agent reported shows: no
// effort, the model alone; no model, nothing.

import { cn } from "@/util/util";
import { EffortItemId, ModelItemId } from "../command-panel/agent-commands";
import { AgentInputs } from "../command-panel/agent-input-store";
import { openCommandPanelOn } from "../command-panel/command-panel-store";

type HeaderModelEffortProps = {
    blockId: string;
    model: string;
    modelTitle: string;
    // #2076: the account cannot use the model; it shows as the way out, in the warning tone.
    modelUnavailable?: boolean;
    effort: string;
    effortTitle: string;
};

function HeaderChoiceButton({
    blockId,
    itemId,
    label,
    title,
    testId,
    warn,
}: {
    blockId: string;
    itemId: string;
    label: string;
    title: string;
    testId: string;
    warn?: boolean;
}) {
    return (
        <button
            type="button"
            className={cn("molten-header-link min-w-0 truncate px-1 cursor-pointer", warn && "text-warning")}
            data-unavailable={warn ? "true" : undefined}
            title={title}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
                e.stopPropagation();
                const trigger = e.currentTarget;
                void AgentInputs.getInstance()
                    .ready(blockId)
                    .then(() => openCommandPanelOn(blockId, itemId, trigger));
            }}
            data-testid={testId}
        >
            {label}
        </button>
    );
}

export function HeaderModelEffort({
    blockId,
    model,
    modelTitle,
    modelUnavailable,
    effort,
    effortTitle,
}: HeaderModelEffortProps) {
    if (!model) {
        return null;
    }
    return (
        <div
            className="molten-header-context-part molten-header-model-effort shrink-0"
            data-testid="molten-header-model-effort"
        >
            <HeaderChoiceButton
                blockId={blockId}
                itemId={ModelItemId}
                label={model}
                title={modelTitle}
                testId="molten-header-model"
                warn={modelUnavailable}
            />
            {effort ? (
                <>
                    <span aria-hidden="true">·</span>
                    <HeaderChoiceButton
                        blockId={blockId}
                        itemId={EffortItemId}
                        label={effort}
                        title={effortTitle}
                        testId="molten-header-effort"
                    />
                </>
            ) : null}
        </div>
    );
}
