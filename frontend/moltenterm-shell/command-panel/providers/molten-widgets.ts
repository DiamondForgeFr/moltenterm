// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The options of MoltenTerm's own widgets (FR-SHELL-049, DS-SHELL-090, v7 D3): the companion (plan usage and its
// source, the linked session), the line map (time window, animation), CI/CD (the runs shown), the Project view (the
// branches its line map draws) and Sessions (filters). Each option carries its scopes and a reset, as the terminal's do;
// a filter is the panel's own, so it has This panel only.

import { atoms, globalStore } from "@/app/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { AgentStates } from "../../agent-state-store";
import { CodingAgentModel } from "../../coding-agent/coding-agent";
import { IntegrateKey, IntegrateOffKey } from "../../companion/companion-integration-model";
import {
    CompanionRoute,
    CompanionTargetMetaKey,
    CompanionUsageExperimentalCommand,
    CompanionUsageGaugesCommand,
} from "../../companion/companion-model";
import { CompanionSessions } from "../../companion/companion-session-store";
import { agentName } from "../../companion/companion-task-model";
import { t } from "../../i18n/i18n";
import { hasKey } from "../../i18n/i18n-core";
import { DefaultFullLineMapDays, FullLineMapDayChoices } from "../../mission/line-map-model";
import { rememberedLineMapDays, rememberLineMapDays } from "../../mission/line-map-store";
import {
    CicdRunsChoices,
    CicdRunsDefault,
    CicdRunsKey,
    LineMapAnimationKey,
    LineMapDaysMetaKey,
    ProjectBranchesChoices,
    ProjectBranchesDefault,
    ProjectBranchesMetaKey,
    sessionsAgentChoices,
    SessionsAgentMetaKey,
    SessionsFolderChoices,
    SessionsFolderMetaKey,
    SessionsStateChoices,
    SessionsStateMetaKey,
} from "../../widget-options";
import { readWorkspaceProject } from "../../workspace-project";
import { metaBinding, readSettings, settingsBinding, writeSettings } from "../bindings";
import {
    CommandProvider,
    PanelChoiceOption,
    PanelContext,
    PanelItem,
    PanelSection,
    ScopeBinding,
} from "../panel-types";

const UsageRpcTimeoutMs = 12000;
// The agents whose plan usage the companion reads (pkg/molten/usage).
const UsageAgents = new Set(["claude", "codex"]);
// The agent with an experimental source to choose (FR-SHELL-028).
const UsageSourceAgent = "claude";
// The agents MoltenTerm's launcher integrates (pkg/molten/agentlaunch).
const IntegratedAgents = new Set(["claude", "codex"]);

// The choices of widget-options.ts carry English labels; the panel shows them in the interface language.
function choiceLabel(prefix: string, c: { value: string; label: string }): string {
    const key = `cmdpanel.choice.${prefix.replace(/:/g, "_")}.${c.value}`;
    return hasKey(key) ? t(key) : c.label;
}

function choiceOptions(prefix: string, choices: readonly { value: string; label: string; icon?: string }[]) {
    return choices.map(
        (c): PanelChoiceOption => ({
            id: `${prefix}:${c.value}`,
            label: choiceLabel(prefix, c),
            value: c.value,
            icon: c.icon,
        })
    );
}

// The same RPCs as the companion's own buttons: wavesrv writes the setting and stops or starts the sources.
function usageCall(command: string, target: string, on: boolean): Promise<void> {
    return TabRpcClient.wshRpcCall(
        command,
        { blockid: target, on },
        { route: CompanionRoute, timeout: UsageRpcTimeoutMs }
    );
}

function settingIncludes(key: string, value: string): boolean {
    const list = readSettings(key);
    return Array.isArray(list) && list.includes(value);
}

// MoltenTerm's integration at launch (FR-SHELL-040-AC7): for every agent, and for the companion's agent when it has a
// launcher. Both are read at the next launch.
function integrationItems(agent: string): PanelItem[] {
    const items: PanelItem[] = [
        {
            id: "companion:integrate",
            type: "toggle",
            label: t("cmdpanel.companion.integration"),
            detail: t("cmdpanel.companion.integrationDetail"),
            icon: "plug",
            keywords: ["hooks", "launcher", "integrated by moltenterm"],
            defaultValue: true,
            scopes: [settingsBinding<boolean>(IntegrateKey, true, "global")],
        },
    ];
    if (!IntegratedAgents.has(agent)) {
        return items;
    }
    const agentOff = (): string[] => {
        const off = readSettings(IntegrateOffKey);
        return Array.isArray(off) ? off : [];
    };
    const writeAgent = (on: boolean) => {
        const rest = agentOff().filter((id) => id !== agent);
        const next = on ? rest : [...rest, agent];
        return writeSettings({ [IntegrateOffKey]: next.length > 0 ? next : null });
    };
    items.push({
        id: "companion:integrateagent",
        type: "toggle",
        label: t("cmdpanel.companion.integrationFor", { agent: agentName(agent) }),
        detail: t("cmdpanel.companion.fromNextLaunch"),
        icon: "plug",
        keywords: ["hooks", "launcher", "integrateoff"],
        defaultValue: true,
        scopes: [
            {
                scope: "global",
                get: () => (agentOff().includes(agent) ? false : undefined),
                set: (on) => writeAgent(on !== false),
                clear: () => writeAgent(true),
            },
        ],
    });
    return items;
}

export function companionSections(ctx: PanelContext): PanelSection[] {
    const target = ctx.meta?.[CompanionTargetMetaKey] as string;
    if (!target) {
        return [];
    }
    const agent = globalStore.get(AgentStates.getInstance().blockAtom(target))?.agent;
    const items: PanelItem[] = [];
    if (UsageAgents.has(agent)) {
        const gaugesOn = settingIncludes("companion:usagegauges", agent);
        // Per agent and in the settings: Everywhere is the only scope it has.
        const gauges: ScopeBinding<boolean> = {
            scope: "global",
            get: () => (settingIncludes("companion:usagegauges", agent) ? true : undefined),
            set: (on) => usageCall(CompanionUsageGaugesCommand, target, on),
            clear: () => usageCall(CompanionUsageGaugesCommand, target, false),
        };
        items.push({
            id: "companion:usage",
            type: "toggle",
            label: t("cmdpanel.companion.planUsage"),
            detail: agentName(agent),
            icon: "gauge",
            keywords: ["limits", "quota", "gauges"],
            defaultValue: false,
            scopes: [gauges],
        });
        // The experimental source is offered only while the gauges show, as in the companion.
        if (agent === UsageSourceAgent && gaugesOn) {
            items.push({
                id: "companion:usagesource",
                type: "choice",
                label: t("cmdpanel.companion.usageSource"),
                icon: "plug",
                keywords: ["model limits", "credits", "experimental"],
                defaultValue: false,
                options: [
                    {
                        id: "usagesource:statusline",
                        label: t("cmdpanel.companion.statusLine"),
                        value: false,
                        detail: t("cmdpanel.companion.statusLineDetail"),
                    },
                    {
                        id: "usagesource:endpoint",
                        label: t("cmdpanel.companion.endpoint"),
                        value: true,
                        // Picking it is the consent the companion's confirmation asks for: the row says what it uses.
                        detail: t("cmdpanel.companion.endpointDetail"),
                    },
                ],
                scopes: [
                    {
                        scope: "global",
                        get: () => (readSettings("companion:usageclaudeoauth") === true ? true : undefined),
                        set: (on: unknown) => usageCall(CompanionUsageExperimentalCommand, target, on === true),
                        clear: () => usageCall(CompanionUsageExperimentalCommand, target, false),
                    },
                ],
            });
        }
    }
    if (agent) {
        items.push(...integrationItems(agent));
    }
    const historyAtom = (ctx.viewModel as any)?.historyAtom;
    if (agent && historyAtom != null) {
        const session = globalStore.get(CompanionSessions.getInstance().sessionAtom(target));
        items.push({
            id: "companion:session",
            type: "action",
            label: t("cmdpanel.companion.linkedSession"),
            detail: session?.title || undefined,
            icon: "clock-rotate-left",
            keywords: ["pick session", "history", "transcript"],
            run: () => globalStore.set(historyAtom, true),
        });
    }
    return [{ id: "widget:companion", kind: "widget", title: t("cmdpanel.companion.title"), items }];
}

export const CompanionProvider: CommandProvider = {
    id: "molten-companion",
    kind: "widget",
    needs: ["view:molten-companion"],
    sections: companionSections,
};

function activeProjectDir(): string {
    return readWorkspaceProject(globalStore.get(atoms.workspace)).dir;
}

// The project's remembered window of the full map, shared by its line maps.
export function lineMapProjectBinding(dir: string): ScopeBinding<number> {
    return {
        scope: "project",
        get: () => rememberedLineMapDays(dir, true),
        set: (days) => rememberLineMapDays(dir, true, days),
        clear: () => rememberLineMapDays(dir, true, undefined),
    };
}

export function lineMapSections(ctx: PanelContext): PanelSection[] {
    const dir = activeProjectDir();
    const reduced = globalStore.get(atoms.prefersReducedMotionAtom);
    const items: PanelItem[] = [
        {
            id: "linemap:days",
            type: "choice",
            label: t("cmdpanel.linemap.timeWindow"),
            icon: "calendar-days",
            keywords: ["days", "period", "range"],
            defaultValue: DefaultFullLineMapDays,
            options: FullLineMapDayChoices.map((d) => ({
                id: `linemap:days:${d}`,
                label: t("cmdpanel.linemap.days", { count: d }),
                value: d,
            })),
            scopes: [
                metaBinding<number>(ctx.blockId, LineMapDaysMetaKey),
                ...(dir ? [lineMapProjectBinding(dir)] : []),
            ],
        },
        {
            id: "linemap:animation",
            type: "toggle",
            label: t("cmdpanel.linemap.animation"),
            icon: "wand-magic-sparkles",
            detail: reduced ? t("cmdpanel.linemap.reducedMotion") : undefined,
            keywords: ["motion", "intro", "trains"],
            defaultValue: true,
            scopes: [
                metaBinding<boolean>(ctx.blockId, LineMapAnimationKey),
                settingsBinding<boolean>(LineMapAnimationKey, true),
            ],
        },
    ];
    return [{ id: "widget:linemap", kind: "widget", title: t("cmdpanel.linemap.title"), items }];
}

export const LineMapProvider: CommandProvider = {
    id: "molten-linemap",
    kind: "widget",
    needs: ["view:molten-linemap"],
    sections: lineMapSections,
};

export function cicdSections(ctx: PanelContext): PanelSection[] {
    return [
        {
            id: "widget:cicd",
            kind: "widget",
            title: t("cmdpanel.cicd.title"),
            items: [
                {
                    id: "cicd:runs",
                    type: "choice",
                    label: t("cmdpanel.cicd.runsShown"),
                    icon: "list-check",
                    keywords: ["local", "remote", "cd", "tab"],
                    defaultValue: CicdRunsDefault,
                    options: choiceOptions("cicd:runs", CicdRunsChoices),
                    scopes: [
                        metaBinding<string>(ctx.blockId, CicdRunsKey),
                        settingsBinding<string>(CicdRunsKey, CicdRunsDefault),
                    ],
                },
            ],
        },
    ];
}

export const CicdProvider: CommandProvider = {
    id: "molten-cicd",
    kind: "widget",
    needs: ["view:molten-cicd"],
    sections: cicdSections,
};

export function projectSections(ctx: PanelContext): PanelSection[] {
    return [
        {
            id: "widget:project",
            kind: "widget",
            title: t("cmdpanel.filters.title"),
            items: [
                {
                    id: "project:branches",
                    type: "choice",
                    label: t("cmdpanel.filters.branches"),
                    icon: "code-branch",
                    keywords: ["filter", "open", "merged", "line map"],
                    defaultValue: ProjectBranchesDefault,
                    options: choiceOptions("project:branches", ProjectBranchesChoices),
                    scopes: [metaBinding<string>(ctx.blockId, ProjectBranchesMetaKey)],
                },
            ],
        },
    ];
}

export const ProjectProvider: CommandProvider = {
    id: "molten-project",
    kind: "widget",
    // The legacy Timeline view shows the same overview.
    when: (ctx) => ctx.view === "molten-project" || ctx.view === "molten-timeline",
    sections: projectSections,
};

export function sessionsSections(ctx: PanelContext): PanelSection[] {
    const filter = (
        id: string,
        label: string,
        icon: string,
        key: string,
        choices: readonly { value: string; label: string }[]
    ) =>
        ({
            id,
            type: "choice",
            label,
            icon,
            keywords: ["filter"],
            defaultValue: "all",
            options: choiceOptions(id, choices),
            scopes: [metaBinding<string>(ctx.blockId, key)],
        }) as PanelItem;
    return [
        {
            id: "widget:sessions",
            kind: "widget",
            title: t("cmdpanel.filters.title"),
            items: [
                filter(
                    "sessions:agent",
                    t("cmdpanel.filters.agent"),
                    "robot",
                    SessionsAgentMetaKey,
                    sessionsAgentChoices(CodingAgentModel.getInstance().choiceOf("")?.known)
                ),
                filter(
                    "sessions:folder",
                    t("cmdpanel.filters.folder"),
                    "folder",
                    SessionsFolderMetaKey,
                    SessionsFolderChoices
                ),
                filter(
                    "sessions:state",
                    t("cmdpanel.filters.state"),
                    "circle-dot",
                    SessionsStateMetaKey,
                    SessionsStateChoices
                ),
            ],
        },
    ];
}

export const SessionsProvider: CommandProvider = {
    id: "molten-sessions",
    kind: "widget",
    needs: ["view:molten-sessions"],
    sections: sessionsSections,
};

export const MoltenWidgetProviders: CommandProvider[] = [
    CompanionProvider,
    LineMapProvider,
    CicdProvider,
    ProjectProvider,
    SessionsProvider,
];
