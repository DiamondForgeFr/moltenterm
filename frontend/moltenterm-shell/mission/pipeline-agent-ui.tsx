// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Ask for help" in the setup panel (FR-MC-038, #1150; the screen's context, #1152): the click opens the agent's terminal on the left, starts the
// agent when none runs there, and hands it the screen's context. With no coding agent installed, or the chosen one
// missing, it says so before any click and offers "Choose an agent" (the panel's coding agent option) instead.

import { atoms, refocusNode } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getActiveTabModel } from "@/app/store/tab-model";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { useBlockAgentState } from "../agent-state-ui";
import { CodingAgentModel } from "../coding-agent/coding-agent";
import { openCommandPanelOn } from "../command-panel/command-panel-store";
import { getLocale, useT } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import { pipelineAgentOf, PipelineAskResult, pipelineTerminalOf } from "./pipeline-agent";
import { usePipelineTab } from "./pipeline-tab-context";
import { helpContextOf, SetupHelp } from "./release-setup-help-model";

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
    // Shared with the steps' Question buttons (#1152): the screen shown, and what became of the last request.
    const help = SetupHelp.getInstance(dir);
    const status = useAtomValue(help.statusAtom, { store: globalStore });
    const screen = useAtomValue(help.screenAtom, { store: globalStore });
    const terminal = useTabTerminal(dir);
    const busy = status === "asking";
    const result: PipelineAskResult = status === "idle" || status === "asking" ? null : status;
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
    useEffect(() => globalStore.set(help.statusAtom, "idle"), [help, known?.state]);
    if (tab == null) {
        return null;
    }
    const chooseAgent = (e: React.MouseEvent<HTMLButtonElement>) => {
        openCommandPanelOn(tab.panelBlockId, "codingagent", e.currentTarget);
    };
    // A terminal already beside the panel (an agent may run there, whatever this computer has installed) is the place
    // to talk: the bar names it rather than offering to choose an agent.
    if (known != null && known.state !== "ready" && !terminal) {
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
            const context = screen
                ? helpContextOf({ locale: getLocale(), screen: screen.screen, panel: screen.panel })
                : panelHelpContext(tab.project);
            await help.ask(tab.askAgent, context);
            const answer = globalStore.get(help.statusAtom);
            if (answer === "none" || answer === "missing") {
                CodingAgentModel.getInstance().refresh(dir);
            }
        });
    const name = known?.state === "ready" ? known.agent.name : "";
    return (
        <div className="flex flex-wrap items-center gap-2 text-12">
            <button type="button" onClick={ask} disabled={busy} className={HelpButton} data-testid="pipeline-help">
                {busy ? <DominoLoader /> : <i className="fa fa-solid fa-circle-question text-11" />}
                {t("pipelineTab.help.ask")}
            </button>
            {result && result !== "sent" ? (
                <span className="text-warning" data-testid="pipeline-help-result">
                    {t(ResultKeys[result], { agent: name })}
                </span>
            ) : terminal ? (
                <LinkedTerminal terminal={terminal} fallbackName={name} />
            ) : result ? (
                <span className="text-muted" data-testid="pipeline-help-result">
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

// The tab's terminal for the project, followed live: once there is one, the bar says so instead of offering to open
// another (#1163).
export function useTabTerminal(dir: string): string {
    const tabAtom = getActiveTabModel()?.tabAtom;
    const terminalAtom = useMemo(
        () =>
            atom((get) => {
                const tab = tabAtom == null ? null : get(tabAtom);
                const blocks = (tab?.blockids ?? [])
                    .map((id) => get(getWaveObjectAtom<Block>(makeORef("block", id))))
                    .filter((b) => b != null);
                return pipelineTerminalOf(blocks, dir);
            }),
        [tabAtom, dir]
    );
    return useAtomValue(terminalAtom, { store: globalStore });
}

// The panel's own block takes the focus back while the click that asked is handled (its frame follows the pointer):
// the terminal gets it once that is over, on the next frame, or the two blocks hand the focus to each other forever.
export function focusTerminalSoon(blockId: string) {
    requestAnimationFrame(() => refocusNode(blockId));
}

// "Claude Code · Marion, on the left" and Go there, which gives the terminal the keyboard.
function LinkedTerminal({ terminal, fallbackName }: { terminal: string; fallbackName: string }) {
    const t = useT();
    const info = useBlockAgentState(terminal);
    const agent = info?.agentname || "";
    const who = agent && info?.firstname ? `${agent} · ${info.firstname}` : agent || info?.firstname || "";
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-muted" data-testid="pipeline-help-linked">
            <span className="min-w-0">
                {who
                    ? t("pipelineTab.help.linkedAgent", { agent: who })
                    : fallbackName
                      ? t("pipelineTab.help.linkedTerminalNamed", { agent: fallbackName })
                      : t("pipelineTab.help.linkedTerminal")}{" "}
            </span>
            <button
                type="button"
                className={HelpButton}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => focusTerminalSoon(terminal)}
                data-testid="pipeline-help-goto"
            >
                <i className="fa fa-solid fa-arrow-left text-11" />
                {t("pipelineTab.help.goto")}
            </button>
        </span>
    );
}
