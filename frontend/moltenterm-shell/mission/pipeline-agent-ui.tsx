// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Ask for help" in the setup panel (FR-MC-038, #1150): the click opens the agent's terminal on the left, starts the
// agent when none runs there, and hands it the screen's context. With no coding agent installed, or the chosen one
// missing, it says so before any click and offers "Choose an agent" (the panel's coding agent option) instead.

import { atoms } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { CodingAgentModel } from "../coding-agent/coding-agent";
import { openCommandPanelOn } from "../command-panel/command-panel-store";
import { useT } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import { pipelineAgentOf, PipelineAskResult } from "./pipeline-agent";
import { usePipelineTab } from "./pipeline-tab-context";

const HelpButton =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-4 border border-border px-2.5 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

const ResultKeys: Record<PipelineAskResult, string> = {
    sent: "pipelineTab.help.sent",
    busy: "pipelineTab.help.busy",
    none: "pipelineTab.help.none",
    missing: "pipelineTab.help.missing",
    failed: "pipelineTab.help.failed",
};

// The panel's own context when no step is concerned.
export function panelHelpContext(project: string): string {
    return `The developer is on the release pipeline setup of ${project} and asks for help with it.`;
}

export function PipelineHelp() {
    const t = useT();
    const tab = usePipelineTab();
    const dir = tab?.dir ?? "";
    const choices = useAtomValue(CodingAgentModel.getInstance().choicesAtom);
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<PipelineAskResult>(null);
    // Read again when the tab comes back: an agent may have been installed meanwhile.
    useEffect(() => {
        if (!dir) {
            return;
        }
        const refresh = () => CodingAgentModel.getInstance().refresh(dir);
        refresh();
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", refresh);
        return () => {
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, [dir]);
    const choice = choices[dir]?.choice;
    const known = choice != null ? pipelineAgentOf(choice, fullConfig?.presets) : null;
    // A failed ask's words hold until the agent's availability changes (one installed or chosen since).
    useEffect(() => setResult(null), [known?.state]);
    if (tab == null) {
        return null;
    }
    const chooseAgent = (e: React.MouseEvent<HTMLButtonElement>) => {
        openCommandPanelOn(tab.panelBlockId, "codingagent", e.currentTarget);
    };
    if (known != null && known.state !== "ready") {
        return (
            <div className="flex flex-wrap items-center gap-2 text-12 text-muted" data-testid="pipeline-agent-none">
                <span className="min-w-0 flex-1">
                    {known.state === "missing"
                        ? t("pipelineTab.help.missing", { agent: known.name })
                        : t("pipelineTab.help.none")}
                </span>
                <button type="button" className={HelpButton} onClick={chooseAgent} data-testid="pipeline-agent-choose">
                    <i className="fa fa-solid fa-robot text-11" />
                    {t("pipelineTab.help.choose")}
                </button>
            </div>
        );
    }
    const ask = () =>
        fireAndForget(async () => {
            setBusy(true);
            setResult(null);
            try {
                const answer = await tab.askAgent({ context: panelHelpContext(tab.project) });
                setResult(answer);
                if (answer === "none" || answer === "missing") {
                    CodingAgentModel.getInstance().refresh(dir);
                }
            } finally {
                setBusy(false);
            }
        });
    const name = known?.state === "ready" ? known.agent.name : "";
    return (
        <div className="flex flex-wrap items-center gap-2 text-12">
            <button type="button" onClick={ask} disabled={busy} className={HelpButton} data-testid="pipeline-help">
                {busy ? <DominoLoader /> : <i className="fa fa-solid fa-circle-question text-11" />}
                {t("pipelineTab.help.ask")}
            </button>
            {result ? (
                <span
                    className={cn(result === "sent" ? "text-muted" : "text-warning")}
                    data-testid="pipeline-help-result"
                >
                    {t(ResultKeys[result], { agent: name })}
                </span>
            ) : (
                <span className="text-muted">
                    {name ? t("pipelineTab.help.hintNamed", { agent: name }) : t("pipelineTab.help.hint")}
                </span>
            )}
        </div>
    );
}
