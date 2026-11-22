// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agent companion's view (FR-SHELL-018): next to a terminal running a coding agent, its session as wavesrv reads
// it from the agent's own transcript. Display only: nothing is sent to the agent.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { ClientModel } from "@/app/store/client-model";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms } from "@/app/store/global";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget, useAtomValueSafe } from "@/util/util";
import { atom, PrimitiveAtom, useAtom, useAtomValue } from "jotai";
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { AgentHookOffers } from "../agent-hooks-store";
import { agentProviderName } from "../agent-state-model";
import { useBlockAgentState } from "../agent-state-ui";
import { CodingAgentModel } from "../coding-agent/coding-agent";
import { EmptyState, EmptyStateAction } from "../empty-state";
import { I18nModel, t as translate, useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { always, TabActivity, whileShown } from "../tab-activity";
import { everyInPanel, usePanelBlockId } from "../view360/offcarpet-model";
import { readWorkspaceProject } from "../workspace-project";
import {
    attachCompanion,
    cleanCustomCommand,
    CompanionAgent,
    companionStartPlan,
    customKey,
    readCompanionAgentMemory,
    startCompanionAgent,
    StartOption,
    tabAttachCandidates,
} from "./companion-attach";
import { PlanUsageSection, ProviderUsageNote } from "./companion-gauges";
import { IntegratedBadge, IntegrationDetails } from "./companion-integration";
import {
    CompanionAnswer,
    CompanionAnswerCommand,
    CompanionCandidate,
    CompanionCloseCommand,
    CompanionEvent,
    CompanionOpenCommand,
    CompanionPickCommand,
    CompanionRoute,
    CompanionSessionsCommand,
    CompanionTargetMetaKey,
    CompanionView,
    hasIntegrationDetails,
    integrationProblem,
    isIntegrated,
    MoltentermCompanionView,
    needsLatest,
    newerView,
    statusMessage,
} from "./companion-model";
import { saveCompanionLayout, useCompanionLayout } from "./companion-prefs";
import { CompanionSessions } from "./companion-session-store";
import { SessionHistoryList } from "./companion-session-ui";
import { CompanionTips } from "./companion-tips";
import { UsageButton } from "./companion-usage";
import { hiddenRowsOf } from "./companion-usage-rows-model";

export { MoltentermCompanionView };

const RpcTimeoutMs = 5000;
// The lease wavesrv keeps a follower for is 45 s.
const LeaseRenewMs = 15000;
const RefreshMs = 10000;

function companionCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: CompanionRoute, timeout: RpcTimeoutMs });
}

export class CompanionViewModel implements ViewModel {
    viewType = MoltentermCompanionView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("book-open");
    viewName = atom((get) => {
        get(I18nModel.getInstance().localeAtom);
        return translate("companion.viewName");
    });
    noPadding = atom(true);
    // The folder's sessions to pick from, opened by Choose from the folder's sessions, the session bar or the command
    // panel's Linked session (FR-SHELL-049).
    historyAtom = atom(false) as PrimitiveAtom<boolean>;
    // Launcher additions or persistent hook management, opened by the Integration badge.
    integrationAtom = atom(false) as PrimitiveAtom<boolean>;
    // The arranging mode, opened by the Arrange button of the session bar (#2395).
    arrangeAtom = atom(false) as PrimitiveAtom<boolean>;
    targetAtom = atom<string>((get) => {
        const block = get(getWaveObjectAtom<Block>(makeORef("block", this.blockId)));
        return (block?.meta?.[CompanionTargetMetaKey] as string) ?? null;
    });

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
    }

    get viewComponent(): ViewComponent {
        return CompanionPanel;
    }
}

// Follows a terminal's companion: opens it in wavesrv under this mount's own lease (a remount or a second companion
// of the same terminal never ends another's), renews it, takes the events; the newest version wins.
function useCompanion(target: string): {
    view: CompanionView;
    error: string;
    viewId: string;
    setView: (v: CompanionView) => void;
} {
    const [view, setViewState] = useState<CompanionView>(null);
    const [error, setError] = useState<string>(null);
    const viewId = useMemo(() => crypto.randomUUID(), [target]);
    const panelId = usePanelBlockId();
    const setView = (next: CompanionView) => {
        if (next?.blockid !== target) {
            return;
        }
        setViewState((cur) => newerView(cur, next));
    };
    useEffect(() => {
        setViewState(null);
        setError(null);
        if (!target) {
            return;
        }
        let cancelled = false;
        const accept = (next: CompanionView) => {
            if (!cancelled) {
                setView(next);
            }
        };
        let unsubscribe = () => {};
        try {
            unsubscribe = waveEventSubscribeSingle({
                eventType: CompanionEvent as WaveEventName,
                scope: makeORef("block", target),
                handler: (event) => accept(event.data as CompanionView),
            });
        } catch (e) {
            console.log("companion: no event bus", e);
        }
        const open = (refresh: boolean) =>
            fireAndForget(async () => {
                try {
                    accept(
                        await companionCall<CompanionView>(CompanionOpenCommand, {
                            blockid: target,
                            viewid: viewId,
                            refresh,
                        })
                    );
                    if (!cancelled) {
                        setError(null);
                    }
                } catch (e) {
                    if (!cancelled) {
                        setError(serverErrorText(e));
                    }
                }
            });
        open(true);
        // The lease must not lapse while the view is hidden: wavesrv would drop the follower.
        const stopRenew = TabActivity.getInstance().every(always(LeaseRenewMs), () => open(false), "companion-lease");
        // While it shows, the companion looks again on a bounded interval, on top of the file watch: a session link
        // that came while nobody looked, agents gone quiet (#600). Paused while hidden; a view that shows again runs
        // it at once, overdue. The same holds while its panel is off-screen on the carpet (#618).
        const stopRefresh = everyInPanel(panelId, whileShown(RefreshMs), () => open(true), "companion-refresh");
        return () => {
            cancelled = true;
            stopRenew();
            stopRefresh();
            unsubscribe();
            fireAndForget(async () => {
                try {
                    await companionCall(CompanionCloseCommand, { blockid: target, viewid: viewId });
                } catch {
                    // wavesrv drops the follower when its lease ends anyway.
                }
            });
        };
    }, [target, viewId, panelId]);
    // An event left out the latest answer this view has no copy of: ask for it.
    const missing = needsLatest(view);
    useEffect(() => {
        if (!missing || !target) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const latest = await companionCall<CompanionAnswer>(CompanionAnswerCommand, {
                    blockid: target,
                    index: 0,
                });
                if (!cancelled && latest != null) {
                    setViewState((cur) =>
                        cur?.latest?.elided && cur.latest.index === latest.index ? { ...cur, latest } : cur
                    );
                }
            } catch {
                // The next event or lease renewal brings it.
            }
        });
        return () => {
            cancelled = true;
        };
    }, [missing, target, view?.latest?.index, view?.latest?.rev]);
    return { view, error, viewId, setView };
}

// The panel's popovers (#2455) serve every state of the companion: the dashboard, the history, the integration page and
// the empty states.
function CompanionPanel(props: ViewComponentProps<CompanionViewModel>) {
    const target = useAtomValue(props.model.targetAtom);
    const session = useAtomValue(CompanionSessions.getInstance().sessionAtom(target));
    return (
        <CompanionTips target={target} session={session?.path ?? ""}>
            <CompanionPanelBody {...props} />
        </CompanionTips>
    );
}

function CompanionPanelBody({ model }: ViewComponentProps<CompanionViewModel>) {
    const t = useT();
    const target = useAtomValue(model.targetAtom);
    const agentState = useBlockAgentState(target);
    const hookOffer = useAtomValue(AgentHookOffers.getInstance().detailsAtom(target));
    const terminal = useAtomValueSafe(target ? getWaveObjectAtom<Block>(makeORef("block", target)) : null);
    const companion = useCompanion(target);
    const { error, viewId, setView } = companion;
    // Behind another provider (FR-AGC-008) the agent's plan usage and usage page are not this session's.
    const provider =
        companion.view?.agent && agentState?.agent === companion.view.agent ? agentProviderName(agentState) : "";
    const view = provider && companion.view?.usage != null ? { ...companion.view, usage: undefined } : companion.view;
    const [history, setHistory] = useAtom(model.historyAtom);
    const [integrationOpen, setIntegrationOpen] = useAtom(model.integrationAtom);
    const [arranging, setArranging] = useAtom(model.arrangeAtom);
    const layout = useCompanionLayout();
    const arrangeButton = useRef<HTMLButtonElement>(null);
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const workspace = useAtomValue(atoms.workspace);
    const agentChoices = useAtomValue(CodingAgentModel.getInstance().choicesAtom);
    const client = useAtomValue(ClientModel.getInstance().clientAtom);
    const [customOpen, setCustomOpen] = useState(false);
    const projectDir = readWorkspaceProject(workspace).repo ?? "";
    useEffect(() => CodingAgentModel.getInstance().refresh(projectDir), [projectDir]);
    const plan = companionStartPlan(
        agentChoices[projectDir]?.choice,
        fullConfig?.presets,
        readCompanionAgentMemory(client)
    );
    const actions = useEmptyActions();
    const folder = (terminal?.meta?.["cmd:cwd"] as string) ?? "";
    const session = view?.session;
    // The terminal's agent label names the session this companion shows, while it is open.
    useEffect(() => {
        CompanionSessions.getInstance().set(target, session);
    }, [target, session?.path, session?.title, session?.command, session?.started, session?.linkedby]);
    useEffect(() => {
        return () => CompanionSessions.getInstance().set(target, null);
    }, [target]);
    useEffect(() => {
        setHistory(false);
        setIntegrationOpen(false);
        setArranging(false);
    }, [target, view?.agent]);
    useEffect(() => {
        if (target && view?.agent) {
            fireAndForget(() => AgentHookOffers.getInstance().refresh(target));
        }
    }, [target, view?.agent]);
    const integrationDetails = hasIntegrationDetails(view, hookOffer);
    const startAgent = (agent: CompanionAgent, key: string, explicit: boolean) => {
        setCustomOpen(false);
        actions.run(t("companion.didNotStart", { name: agent.name }), () =>
            startCompanionAgent(model.blockId, target, agent, key, explicit)
        );
    };
    const startAction: EmptyStateAction =
        plan.kind === "direct"
            ? {
                  label: t("companion.startHere", { name: plan.agent.name }),
                  busyLabel: t("companion.starting"),
                  busy: actions.busy,
                  onClick: () => startAgent(plan.agent, plan.key, plan.explicit),
                  testId: "companion-start-agent",
              }
            : {
                  label: t("companion.startAgent"),
                  busyLabel: t("companion.starting"),
                  busy: actions.busy,
                  menu: true,
                  onClick: (e) =>
                      showStartMenu(
                          e,
                          plan.options,
                          (option) => startAgent(option.agent, option.key, false),
                          () => setCustomOpen(true)
                      ),
                  testId: "companion-start-agent",
              };
    const customForm = customOpen ? (
        <CustomCommandForm
            busy={actions.busy}
            onStart={(command) => startAgent({ name: command, command }, customKey(command), false)}
            onCancel={() => setCustomOpen(false)}
        />
    ) : null;
    const attachAction: EmptyStateAction = {
        label: t("companion.attach"),
        menu: true,
        disabled: actions.busy,
        onClick: (e) =>
            showAttachMenu(e, target, (id) =>
                actions.run(t("companion.attachFailed"), () => attachCompanion(model.blockId, id))
            ),
        testId: "companion-attach",
    };
    if (!target) {
        return (
            <EmptyState
                icon="link-slash"
                title={t("companion.noTerminal")}
                hint={t("companion.noTerminalHint")}
                primary={attachAction}
                secondary={startAction}
                alert={actions.alert}
                details={actions.raw}
                testId="companion-noterminal"
            >
                {customForm}
            </EmptyState>
        );
    }
    if (error && view == null) {
        return (
            <EmptyState
                icon="triangle-exclamation"
                title={t("companion.unavailable")}
                hint={t("companion.unavailableHint")}
                details={error}
            />
        );
    }
    // The plan usage stays in view while the companion asks which session is the terminal's (v7 D4).
    const usage = provider ? (
        <ProviderUsageNote provider={provider} native={agentState?.nativeprovider ?? ""} />
    ) : view?.usage != null && view.agent ? (
        <PlanUsageSection target={target} agent={view.agent} rows={{ hidden: hiddenRowsOf(layout, view.agent) }} />
    ) : null;
    if (history) {
        return (
            <WithUsage usage={usage}>
                <SessionHistory
                    target={target}
                    viewId={viewId}
                    onPicked={(v) => {
                        setView(v);
                        setHistory(false);
                    }}
                    onClose={() => setHistory(false)}
                />
            </WithUsage>
        );
    }
    if (integrationOpen && integrationDetails) {
        return <IntegrationDetails view={view} target={target} onClose={() => setIntegrationOpen(false)} />;
    }
    const message = statusMessage(view);
    if (message != null && view?.status === "noagent") {
        return (
            <EmptyState
                icon="terminal"
                title={message.title}
                hint={message.detail}
                primary={startAction}
                secondary={{ ...attachAction, label: t("companion.attachOther") }}
                alert={actions.alert}
                details={actions.raw}
                testId="companion-noagent"
            >
                {customForm}
            </EmptyState>
        );
    }
    if (message != null) {
        const withUsage = view?.status === "searching" && usage != null;
        const empty = (
            <EmptyState
                icon={StatusIcons[view?.status] ?? "book-open"}
                loading={view?.status == null || view.status === "loading"}
                title={message.title}
                hint={message.detail}
                secondary={
                    view?.status === "searching"
                        ? {
                              label: t("companion.chooseSession"),
                              onClick: () => setHistory(true),
                              testId: "companion-history-open",
                          }
                        : null
                }
                details={message.raw}
            >
                <IntegrationNotice view={view} />
                {integrationDetails ? (
                    <IntegratedBadge
                        onOpen={() => setIntegrationOpen(true)}
                        persistent={!isIntegrated(view) && hookOffer?.persistent === true}
                    />
                ) : null}
                {/* The plan usage section above already stands for usage while it shows. */}
                {withUsage ? null : <UsageButton view={view} variant="button" />}
            </EmptyState>
        );
        return withUsage ? <WithUsage usage={usage}>{empty}</WithUsage> : empty;
    }
    const leaveArranging = () => {
        setArranging(false);
        queueMicrotask(() => arrangeButton.current?.focus());
    };
    return (
        <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto" data-testid="companion-scroll">
            <Suspense
                fallback={
                    <div className="px-(--mt-companion-inset) py-3 text-12 text-muted">
                        <DominoLoader className="mr-1.5" />
                        {t("companion.loading")}
                    </div>
                }
            >
                <CompanionDashboard
                    view={view}
                    target={target}
                    companionId={model.blockId}
                    agentState={agentState}
                    provider={provider}
                    dir={projectDir || folder}
                    folder={folder}
                    layout={layout}
                    onSaveLayout={saveCompanionLayout}
                    arranging={arranging}
                    onArrange={() => setArranging(true)}
                    onLeaveArranging={leaveArranging}
                    arrangeRef={arrangeButton}
                    integrationDetails={integrationDetails}
                    persistentIntegration={!isIntegrated(view) && hookOffer?.persistent === true}
                    onHistory={() => {
                        setArranging(false);
                        setHistory(true);
                    }}
                    onIntegration={() => {
                        setArranging(false);
                        setIntegrationOpen(true);
                    }}
                    onBackToCurrent={() =>
                        fireAndForget(async () => {
                            try {
                                setView(
                                    await companionCall<CompanionView>(CompanionPickCommand, {
                                        blockid: target,
                                        viewid: viewId,
                                        path: "",
                                    })
                                );
                            } catch (e) {
                                console.log("companion: back to the current session", e);
                            }
                        })
                    }
                />
            </Suspense>
        </div>
    );
}

// The dashboard (#2441): the hero, the blocks' flow and the arranging mode, loaded on demand, out of the startup bundle.
const CompanionDashboard = lazy(() => import("./companion-dashboard").then((m) => ({ default: m.CompanionDashboard })));

function WithUsage({ usage, children }: { usage: React.ReactNode; children: React.ReactNode }) {
    if (usage == null) {
        return <>{children}</>;
    }
    return (
        <div className="flex h-full min-h-0 w-full flex-col" data-testid="companion-with-usage">
            {usage}
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </div>
    );
}

const StatusIcons: Record<string, string> = {
    loading: "book-open",
    unsupportedagent: "robot",
    remote: "network-wired",
    searching: "clock-rotate-left",
    unsupportedformat: "file-circle-question",
    error: "triangle-exclamation",
};

// One action at a time; a failure reads in plain words, its raw error under Details.
function useEmptyActions(): {
    busy: boolean;
    alert: string;
    raw: string;
    run: (failure: string, fn: () => Promise<unknown>) => void;
} {
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<{ alert: string; raw: string }>(null);
    const run = (failure: string, fn: () => Promise<unknown>) => {
        if (busy) {
            return;
        }
        setBusy(true);
        setFailed(null);
        fireAndForget(async () => {
            try {
                await fn();
            } catch (e) {
                setFailed({ alert: failure, raw: serverErrorText(e) });
            } finally {
                setBusy(false);
            }
        });
    };
    return { busy, alert: failed?.alert, raw: failed?.raw, run };
}

// Under the button, like the other menus opened from a button; Shift+F10 on it lands there too.
function showAttachMenu(e: React.MouseEvent<HTMLButtonElement>, current: string, onPick: (blockId: string) => void) {
    const rect = e.currentTarget.getBoundingClientRect();
    const candidates = tabAttachCandidates(current);
    const items: ContextMenuItem[] =
        candidates.length === 0
            ? [{ label: translate("companion.noTerminalInTab"), enabled: false }]
            : candidates.map((c) => ({
                  label: c.label,
                  type: c.current ? "checkbox" : "normal",
                  checked: c.current,
                  enabled: !c.current,
                  click: () => onPick(c.blockId),
              }));
    const event = {
        clientX: rect.left,
        clientY: rect.bottom + 4,
        target: e.currentTarget,
        stopPropagation: () => e.stopPropagation(),
        preventDefault: () => e.preventDefault(),
    } as unknown as React.MouseEvent;
    ContextMenuModel.getInstance().showContextMenu(items, event);
}

// The agents found on this computer (the last one used first), the commands typed before, then "Other command…" (#1460).
function showStartMenu(
    e: React.MouseEvent<HTMLButtonElement>,
    options: StartOption[],
    onPick: (option: StartOption) => void,
    onOther: () => void
) {
    const rect = e.currentTarget.getBoundingClientRect();
    const items: ContextMenuItem[] = [];
    if (!options.some((o) => !o.custom)) {
        items.push({ label: translate("companion.noAgentFound"), enabled: false });
    }
    for (const option of options) {
        items.push({ label: option.agent.name, click: () => onPick(option) });
    }
    items.push({ type: "separator" });
    items.push({ label: translate("companion.otherCommand"), click: onOther });
    const event = {
        clientX: rect.left,
        clientY: rect.bottom + 4,
        target: e.currentTarget,
        stopPropagation: () => e.stopPropagation(),
        preventDefault: () => e.preventDefault(),
    } as unknown as React.MouseEvent;
    ContextMenuModel.getInstance().showContextMenu(items, event);
}

const CommandInputClass =
    "w-full min-w-0 rounded-4 border border-border bg-transparent px-2 py-1.5 font-mono text-12 leading-5 text-primary outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--mt-focus-ring)";

// Any agent CLI can be named by its command; it is typed into the terminal as the developer wrote it.
function CustomCommandForm({
    busy,
    onStart,
    onCancel,
}: {
    busy: boolean;
    onStart: (command: string) => void;
    onCancel: () => void;
}) {
    const t = useT();
    const inputId = useId();
    const [text, setText] = useState("");
    const command = cleanCustomCommand(text);
    const submit = () => {
        if (command !== "" && !busy) {
            onStart(command);
        }
    };
    return (
        <form
            className="mt-2 flex w-full flex-col gap-1.5 text-left"
            data-testid="companion-custom-command"
            onSubmit={(e) => {
                e.preventDefault();
                submit();
            }}
        >
            <label htmlFor={inputId} className="text-12 text-secondary">
                {t("companion.otherCommandLabel")}
            </label>
            <input
                id={inputId}
                type="text"
                autoFocus
                spellCheck={false}
                value={text}
                placeholder={t("companion.otherCommandPlaceholder")}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        e.stopPropagation();
                        onCancel();
                    }
                }}
                className={CommandInputClass}
            />
            <div className="flex items-center justify-end gap-2">
                <button
                    type="button"
                    className="cursor-pointer rounded-4 border border-border px-3 py-1 text-12 text-secondary hover:bg-hover hover:text-primary"
                    onClick={onCancel}
                >
                    {t("companion.otherCommandCancel")}
                </button>
                <button
                    type="submit"
                    className="molten-btn inline-flex h-row cursor-pointer items-center gap-1.5 rounded-6 px-3 text-12 font-medium disabled:opacity-60"
                    disabled={command === "" || busy}
                    data-testid="companion-custom-start"
                >
                    {t("companion.otherCommandStart")}
                    <MoltenWave />
                </button>
            </div>
        </form>
    );
}

// The folder's sessions since the agent started, this terminal's current one first (DS-SHELL-060): the former picker,
// now opened on demand. Choosing one links it as picked, the current one included (a guess the user confirms).
function SessionHistory({
    target,
    viewId,
    onPicked,
    onClose,
}: {
    target: string;
    viewId: string;
    onPicked: (v: CompanionView) => void;
    onClose: () => void;
}) {
    const [sessions, setSessions] = useState<CompanionCandidate[]>(null);
    const [error, setError] = useState<string>(null);
    useEffect(() => {
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const list = await companionCall<CompanionCandidate[]>(CompanionSessionsCommand, {
                    blockid: target,
                    viewid: viewId,
                });
                if (!cancelled) {
                    setSessions(list ?? []);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(serverErrorText(e));
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [target, viewId]);
    const pick = (path: string) =>
        fireAndForget(async () => {
            try {
                onPicked(
                    await companionCall<CompanionView>(CompanionPickCommand, { blockid: target, viewid: viewId, path })
                );
            } catch (e) {
                setError(serverErrorText(e));
            }
        });
    return <SessionHistoryList sessions={sessions} error={error} now={Date.now()} onPick={pick} onClose={onClose} />;
}

function IntegrationNotice({ view, className }: { view: CompanionView; className?: string }) {
    const problem = integrationProblem(view);
    if (problem == null) {
        return null;
    }
    return (
        <div
            className={cn("max-w-[360px] text-11 text-warning", className)}
            data-testid="companion-integration-problem"
        >
            {problem}
        </div>
    );
}
