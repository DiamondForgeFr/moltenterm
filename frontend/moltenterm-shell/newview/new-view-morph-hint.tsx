// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The launcher's way forward when nothing matches (FR-SHELL-089, #1672): ask the workspace's agent for the tool with
// /morph, or, with no agent in the workspace, show the agents that can start. Mounted only on an empty result, so the
// agents' state changes re-render nothing else of the launcher.

import { atoms } from "@/app/store/global";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import type React from "react";
import { useEffect, useMemo } from "react";
import { agentCallName, type AgentStateInfo } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { morphCall, morphCallText, workspaceMorphTarget } from "../morph/morph-call-model";

type NewViewMorphHintProps = {
    query: string;
    onAsk: (agent: AgentStateInfo, request: string) => Promise<void>;
    onStartAgent: () => void;
    // Enter on the empty result runs the hint's one action: the launcher reads it here.
    actionRef: React.RefObject<() => void>;
};

export function NewViewMorphHint({ query, onAsk, onStartAgent, actionRef }: NewViewMorphHintProps) {
    const t = useT();
    const data = useAtomValue(AgentStates.getInstance().dataAtom);
    const wsId = useAtomValue(atoms.workspaceId);
    const tabId = useAtomValue(atoms.staticTabId);
    const agent = useMemo(() => workspaceMorphTarget(data, wsId, tabId), [data, wsId, tabId]);
    const ask = () => fireAndForget(() => onAsk(agent, query));
    const action = agent ? ask : onStartAgent;
    useEffect(() => {
        actionRef.current = action;
        return () => {
            actionRef.current = null;
        };
    });
    const btn = "molten-btn cursor-pointer self-start rounded-4 px-2.5 py-1 text-12";
    if (agent) {
        const name = agentCallName(agent);
        return (
            <div className="flex flex-col gap-2 px-3.5 pb-3" data-testid="new-view-morph">
                <button
                    type="button"
                    className={btn}
                    data-testid="new-view-morph-ask"
                    title={t("newView.morph.askTitle", { text: morphCallText(agent.agent, query), agent: name })}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={ask}
                >
                    {morphCall(agent.agent)
                        ? t("newView.morph.ask", { agent: name, morph: morphCall(agent.agent) })
                        : t("newView.morph.askPlain", { agent: name })}
                    <MoltenWave />
                </button>
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-2 px-3.5 pb-3" data-testid="new-view-morph">
            <span className="text-12 text-muted">{t("newView.morph.noAgent")}</span>
            <button
                type="button"
                className={btn}
                data-testid="new-view-morph-start"
                title={t("newView.morph.startTitle")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onStartAgent}
            >
                {t("newView.morph.start")}
                <MoltenWave />
            </button>
        </div>
    );
}
