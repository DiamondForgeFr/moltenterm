// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The mod design panel (FR-MORPH-019, DS-MORPH-016): what /morph opens to the right of the agent's own terminal, in its
// tab (a tab of its own, with a terminal on its left, only when it cannot go there). It carries the steps of the guide
// in plain words, kept in step with the conversation by the agent through `molten morph design`, and relays the
// developer's clicks to the agent. It never blocks: every step can be skipped or done in the terminal. What the
// developer decides is remembered by the workflow's memory (#1879), shown at the end.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { getApi, refocusNode } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getActiveTabModel } from "@/app/store/tab-model";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { Atom, atom, useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useBlockAgentState } from "../agent-state-ui";
import { EmptyState } from "../empty-state";
import { I18nModel, useT } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import { serverErrorText } from "../i18n/server-text";
import { LearnedSection } from "../learning/learned-section";
import { WorkflowMorphDesign } from "../learning/learning-model";
import { useLearned } from "../learning/use-learned";
import { LoadingState } from "../suite/suite";
import { DesignActions, makeDesignActions } from "./morph-design-actions";
import {
    designTitle,
    MoltentermMorphDesignView,
    MorphDesign,
    MorphDesignPanelMetaKey,
    MorphDesignTabIcon,
    MorphDesignTermMetaKey,
    MorphReceiver,
    MorphSteps,
    panelTitleOf,
    readMorphDesignTarget,
    receiverOf,
    ToldKeys,
    withLiveAgent,
} from "./morph-design-model";
import { StepBlock } from "./morph-design-steps";
import { useMorphDesign } from "./use-morph-design";

export { MoltentermMorphDesignView };

export class MorphDesignViewModel implements ViewModel {
    viewType = MoltentermMorphDesignView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom(MorphDesignTabIcon);
    // "Conception · <mod>", following the interface language: the panel's title in its header, beside the agent.
    viewName: Atom<string>;
    noPadding = atom(true);

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        const blockAtom = getWaveObjectAtom<Block>(makeORef("block", blockId));
        this.viewName = atom((get) => {
            const locale = get(I18nModel.getInstance().localeAtom);
            const target = readMorphDesignTarget(get(blockAtom)?.meta?.[MorphDesignPanelMetaKey]);
            return panelTitleOf(target, (key, vars) => translate(locale, key, vars));
        });
    }

    get viewComponent(): ViewComponent {
        return MorphDesignView;
    }
}

const HelpButton =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-4 border border-border px-2.5 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

// The terminal beside the panel, followed live: the agent's own terminal the panel was placed next to (term, while it
// is still in the tab), else the one a dedicated tab opened for the mod, else the tab's first.
export function useDesignTerminal(mod: string, term?: string): string {
    const tabAtom = getActiveTabModel()?.tabAtom;
    const terminalAtom = useMemo(
        () =>
            atom((get) => {
                const tab = tabAtom == null ? null : get(tabAtom);
                const terms = (tab?.blockids ?? [])
                    .map((id) => get(getWaveObjectAtom<Block>(makeORef("block", id))))
                    .filter((b) => b?.meta?.view === "term");
                const beside = term ? terms.find((b) => b.oid === term) : null;
                return (beside ?? terms.find((b) => b.meta[MorphDesignTermMetaKey] === mod) ?? terms[0])?.oid ?? "";
            }),
        [tabAtom, mod, term]
    );
    return useAtomValue(terminalAtom, { store: globalStore });
}

// Gives the terminal the keyboard on the next frame: the panel's own block takes the focus back while the click that
// asked is handled.
function focusSoon(blockId: string) {
    requestAnimationFrame(() => refocusNode(blockId));
}

// Who gets the developer's choices, and what became of the last one.
function AgentBar({ design, receiver, terminal }: { design: MorphDesign; receiver: MorphReceiver; terminal: string }) {
    const t = useT();
    const told = design.told;
    const agentName = told?.to || receiver?.name || "";
    const goThere = () => {
        if (receiver == null) {
            return;
        }
        if (receiver.here || !receiver.tabId) {
            focusSoon(receiver.blockId);
            return;
        }
        getApi().setActiveTab(receiver.tabId);
    };
    return (
        <div className="flex flex-col gap-1 px-5 pt-2" data-testid="morph-agent-bar">
            <div className="flex flex-wrap items-center gap-2 text-12 text-muted">
                {receiver != null ? (
                    <>
                        <span className="min-w-0" data-testid="morph-agent-receiver">
                            {t(receiver.here ? "morphDesign.agent.getsHere" : "morphDesign.agent.gets", {
                                agent: receiver.name,
                            })}
                        </span>
                        <button type="button" className={HelpButton} onClick={goThere} data-testid="morph-agent-goto">
                            <i className="fa fa-solid fa-arrow-left text-11" aria-hidden />
                            {t("morphDesign.agent.goto")}
                        </button>
                    </>
                ) : (
                    <>
                        <span className="min-w-0 flex-1" data-testid="morph-agent-none">
                            {t("morphDesign.agent.none")}
                        </span>
                        {terminal ? (
                            <button
                                type="button"
                                className={HelpButton}
                                onClick={() => focusSoon(terminal)}
                                data-testid="morph-agent-terminal"
                            >
                                <i className="fa fa-solid fa-arrow-left text-11" aria-hidden />
                                {t("morphDesign.agent.terminal")}
                            </button>
                        ) : null}
                    </>
                )}
            </div>
            {told != null ? (
                <p
                    className={told.status === "noagent" ? "text-12 text-warning" : "text-12 text-muted"}
                    data-testid="morph-told"
                    data-status={told.status}
                >
                    {t(ToldKeys[told.status], { agent: agentName })}
                </p>
            ) : null}
        </div>
    );
}

function MorphDesignView({ model }: ViewComponentProps<MorphDesignViewModel>) {
    const t = useT();
    const block = useAtomValue(getWaveObjectAtom<Block>(makeORef("block", model.blockId)));
    const target = readMorphDesignTarget(block?.meta?.[MorphDesignPanelMetaKey]);
    if (target == null) {
        return (
            <EmptyState
                icon={MorphDesignTabIcon}
                title={t("morphDesign.noDesign")}
                hint={t("morphDesign.noDesignHint")}
            />
        );
    }
    return <DesignPanel key={target.mod} mod={target.mod} name={target.name} term={target.term} />;
}

function DesignPanel({ mod, name, term }: { mod: string; name?: string; term?: string }) {
    const t = useT();
    const state = useMorphDesign(mod);
    const learned = useLearned(WorkflowMorphDesign);
    const terminal = useDesignTerminal(mod, term);
    const terminalAgent = useBlockAgentState(terminal || null);
    // The agent wavesrv named may have ended since: the window's agent states say so at once, without waiting for the
    // design to change.
    const receiverAgent = useBlockAgentState(state.design?.agent?.blockid || null);
    const actions: DesignActions = useMemo(() => makeDesignActions(mod), [mod]);
    // The clicks in flight, each by its own key: only the control that was clicked waits, the rest of the panel stays
    // usable.
    const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set<string>());
    const [error, setError] = useState<string>(null);
    const apply = state.apply;
    const run = useCallback(
        (key: string, action: () => Promise<MorphDesign>) => {
            setBusy((cur) => new Set(cur).add(key));
            setError(null);
            action()
                .then((design) => apply(design))
                .catch((e) => setError(serverErrorText(e)))
                .finally(() =>
                    setBusy((cur) => {
                        const next = new Set(cur);
                        next.delete(key);
                        return next;
                    })
                );
        },
        [apply]
    );
    const focusTerminal = useCallback(() => {
        if (terminal) {
            focusSoon(terminal);
        }
    }, [terminal]);
    if (state.design == null) {
        if (!state.ready) {
            return <LoadingState caption={t("morphDesign.loading")} />;
        }
        return (
            <EmptyState
                icon={MorphDesignTabIcon}
                title={t("morphDesign.missing.title")}
                hint={t("morphDesign.missing.hint", { mod })}
            />
        );
    }
    const design = withLiveAgent(state.design, !!receiverAgent?.agentname);
    const fallback =
        terminal && terminalAgent?.agentname
            ? {
                  blockId: terminal,
                  name: [terminalAgent.firstname, terminalAgent.agentname].filter(Boolean).join(" · "),
              }
            : null;
    const title = designTitle(design) || name || mod;
    return (
        <div className="flex h-full min-h-0 flex-col overflow-y-auto pb-8" data-testid="morph-design" data-mod={mod}>
            <header className="flex flex-col gap-1 px-5 pt-5">
                <h2 className="text-14 font-medium text-primary" data-testid="morph-design-title">
                    {t("morphDesign.title", { mod: title })}
                </h2>
                <p className="text-12 text-muted" data-testid="morph-design-origin">
                    {t("morphDesign.origin")}
                </p>
            </header>
            <AgentBar design={design} receiver={receiverOf(design, fallback)} terminal={terminal} />
            {error ? (
                <p className="px-5 pt-2 text-12 text-danger" role="alert" data-testid="morph-error">
                    {error}
                </p>
            ) : null}
            <div className="flex flex-col px-5">
                {MorphSteps.map((id) => (
                    <StepBlock
                        key={id}
                        id={id}
                        design={design}
                        defaults={learned.defaults}
                        actions={actions}
                        busy={busy}
                        run={run}
                        focusTerminal={focusTerminal}
                    />
                ))}
            </div>
            <LearnedSection workflow={WorkflowMorphDesign} hideWhenEmpty className="mx-5 mt-8" />
        </div>
    );
}
