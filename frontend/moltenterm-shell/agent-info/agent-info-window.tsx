// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Everything about <agent>" (FR-SHELL-084): one window, from the link under an agent in the sidebar and from the plug
// in its terminal's header. It shows what MoltenTerm knows of the agent, for Claude Code and Codex alike: its tool,
// model and effort, where it works and since when, its sub-agents, the agents it is linked to, its MoltenTerm MCP
// servers, the commands it ran, the pages shared with it and its view. Sections are a list (AgentInfoSections), so
// later stories add theirs (cost, context used) without touching the others; a section with nothing to show is left out.
// #1543 widens it to two columns: what the agent does on the left, what it can use (MCP servers, skills, plugins, read
// from its adapter) on the right, each long list shown in part so the window does not scroll forever.

import { atoms } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentLinksPanel } from "../agent-links/agent-links-menu";
import { BlockLinks } from "../agent-links/agent-links-model";
import { AgentLinks } from "../agent-links/agent-links-store";
import {
    agentEffortPart,
    agentModelPart,
    agentProviderTitle,
    agentStateLabel,
    agentToolName,
    type AgentStateInfo,
} from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import {
    AgentTab,
    BrowserAgentRouteId,
    BrowserAgentStateCommand,
    type PanelAgentState,
} from "../browser/browser-agent";
import { BrowserActiveMetaKey, MoltentermBrowserView, readBrowserState } from "../browser/browser-model";
import { useCompanionFollow } from "../companion/companion-follow";
import type { CompanionView } from "../companion/companion-model";
import { DialogFrame } from "../dialog-frame";
import { useLocale, useT, useTCount } from "../i18n/i18n";
import { usePaneStatus } from "../pane-status";
import { AgentAvatar, agentDisplayName, agentDoing, AgentGlyph, WorkingDominoes } from "../sidebar/sidebar-agents";
import { agentRowLook } from "../sidebar/sidebar-agents-model";
import type { PaneState } from "../status-bar-model";
import { DominoLoader } from "../suite/suite";
import { always, TabActivity } from "../tab-activity";
import { useTabIdentity } from "../tab-identity-ui";
import { pathBaseName, readWorkspaceProject } from "../workspace-project";
import { readWorktreeLink } from "../worktree-model";
import { goToAgent, useLinkedAgents, useWorkspaceName, type LinkedAgentRow } from "./agent-info-hooks";
import { agentTool, sharedPages, startedAgo, type SharedPage } from "./agent-info-model";
import {
    commandRows,
    fetchAgentToolkit,
    serverRows,
    ToolkitPreviewRows,
    type AgentToolkit,
    type ServerRow,
    type ToolkitPlugin,
    type ToolkitSkill,
} from "./agent-toolkit-model";
import { AgentWorks } from "./agent-works";
import { SubagentsSection } from "./subagents-section";

export const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";
const AccentButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";
export const SectionTitle = "mt-3.5 mb-1.5 text-11 font-semibold tracking-[0.07em] text-muted uppercase";
const Line = "flex w-full items-center gap-2 rounded-6 px-2 py-1.5 text-left text-12 text-secondary";
const LineButton = cn(Line, "cursor-pointer hover:bg-white/[0.06] hover:text-primary");
const Chip =
    "inline-flex h-5 items-center gap-1 rounded-full bg-white/[0.07] px-[7px] font-mono text-11 text-secondary";
const PagesPollMs = 5000;
const PageCallTimeoutMs = 3000;

// What a section reads: the agent, its companion, its links and where it works.
export type AgentInfoContext = {
    blockId: string;
    info: AgentStateInfo;
    companion: CompanionView;
    links: BlockLinks;
    pane: PaneState;
    meta: Record<string, any>;
    close: () => void;
};

// column: where a section sits on a wide window (#1543); "top" spans both columns. A narrow window stacks them, top,
// then main, then side.
export type AgentInfoSection = {
    key: string;
    column: "top" | "main" | "side";
    Component: React.ComponentType<{ ctx: AgentInfoContext }>;
};

export function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
    if (!value) {
        return null;
    }
    return (
        <div className="min-w-0 rounded-6 bg-white/[0.05] px-[11px] py-[9px]" title={title ?? value}>
            <small className="block text-11 text-muted">{label}</small>
            <b className="block truncate text-12 font-semibold text-primary">{value}</b>
        </div>
    );
}

function FactsSection({ ctx }: { ctx: AgentInfoContext }) {
    const t = useT();
    const locale = useLocale();
    const { info, companion, pane } = ctx;
    const wsName = useWorkspaceName(info?.workspaceid);
    const [workspace] = WOS.useWaveObjectValue<Workspace>(WOS.makeORef("workspace", info?.workspaceid ?? ""));
    const project = pane?.name || pathBaseName(readWorkspaceProject(workspace).dir);
    const model = agentModelPart(info) || companion?.session?.model || "";
    const effort = (model && agentEffortPart(info)) || companion?.session?.effort || "";
    const branch = pane?.branch || companion?.session?.branch || "";
    const worktree = pane?.worktree ? pathBaseName(pane.root || pane.dir) : "";
    const started = info?.started || companion?.session?.started || 0;
    const place = [wsName, project].filter(Boolean).join(" · ");
    return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2" data-testid="agent-info-facts">
            <Fact
                label={t("agentInfo.fact.tool")}
                value={agentToolName(info)}
                title={agentProviderTitle(info) || undefined}
            />
            <Fact label={t("agentInfo.fact.model")} value={model} />
            <Fact label={t("agentInfo.fact.effort")} value={effort} />
            <Fact label={t("agentInfo.fact.workspace")} value={place} />
            <Fact
                label={t(worktree ? "agentInfo.fact.worktree" : "agentInfo.fact.branch")}
                value={worktree ? [worktree, branch].filter(Boolean).join(" · ") : branch}
            />
            <Fact
                label={t("agentInfo.fact.started")}
                value={startedAgo(started, Date.now(), locale)}
                title={started ? new Date(started).toLocaleString(locale) : undefined}
            />
        </div>
    );
}

function LinkedLine({ row, ctx }: { row: LinkedAgentRow; ctx: AgentInfoContext }) {
    const t = useT();
    const tc = useTCount();
    const wsName = useWorkspaceName(row.workspaceId);
    const reachable = row.info != null;
    const content = (
        <>
            <AgentGlyph name={row.dir} size={14} />
            <span className="shrink-0 text-primary">{row.name}</span>
            <span className="min-w-0 truncate text-muted">
                {row.goal || t(row.dir === "out" ? "agentInfo.link.out" : "agentInfo.link.in")}
                {row.count > 1 ? ` · ${tc("agentInfo.link.times", row.count)}` : ""}
            </span>
            <span className="ml-auto shrink-0 text-11 text-muted">{wsName}</span>
        </>
    );
    if (!reachable) {
        return (
            <div className={Line} data-testid="agent-info-link">
                {content}
            </div>
        );
    }
    return (
        <button
            type="button"
            className={LineButton}
            title={t("agentInfo.link.goTo", { name: row.name })}
            data-testid="agent-info-link"
            onClick={() => {
                ctx.close();
                fireAndForget(() => goToAgent(row.info));
            }}
        >
            {content}
        </button>
    );
}

function LinkedSection({ ctx }: { ctx: AgentInfoContext }) {
    const t = useT();
    const rows = useLinkedAgents(ctx.blockId);
    if (rows.length === 0) {
        return null;
    }
    return (
        <section data-testid="agent-info-linked">
            <h5 className={SectionTitle}>{t("agentInfo.linked")}</h5>
            {rows.map((r) => (
                <LinkedLine key={`${r.dir}:${r.blockId}`} row={r} ctx={ctx} />
            ))}
        </section>
    );
}

const McpDot: Record<string, string> = {
    connected: "bg-success",
    reconnecting: "bg-warning",
    broken: "bg-error",
    stopped: "bg-secondary",
    legacy: "bg-success",
};

const ConfigDot: Record<string, string> = {
    configured: "bg-secondary",
    needsapproval: "bg-warning",
    off: "bg-white/20",
};

type ToolkitLoad = { status: "loading" | "ready" | "failed"; toolkit?: AgentToolkit };

// Read once when the window opens (and when the agent or its folder changes): no poller (Epic #446).
function useAgentToolkit(agent: string, cwd: string): ToolkitLoad {
    const [load, setLoad] = useState<ToolkitLoad>({ status: "loading" });
    useEffect(() => {
        if (!agent) {
            setLoad({ status: "ready", toolkit: { supported: false } });
            return;
        }
        let cancelled = false;
        setLoad({ status: "loading" });
        fetchAgentToolkit(agent, cwd)
            .then((toolkit) => !cancelled && setLoad({ status: "ready", toolkit: toolkit ?? { supported: false } }))
            .catch((e) => {
                console.log("agent info: toolkit", e);
                if (!cancelled) {
                    setLoad({ status: "failed" });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [agent, cwd]);
    return load;
}

function originLabel(t: ReturnType<typeof useT>, origin: string, plugin?: string): string {
    return t(`agentInfo.toolkit.scope.${origin}`, { plugin: plugin ?? "" });
}

// A list that shows its first rows, and the rest on demand: the window never grows into an endless scroll.
function Preview<T>({ rows, render, testId }: { rows: T[]; render: (row: T) => React.ReactNode; testId: string }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const shown = open ? rows : rows.slice(0, ToolkitPreviewRows);
    return (
        <div data-testid={testId}>
            {shown.map(render)}
            {rows.length > ToolkitPreviewRows ? (
                <button
                    type="button"
                    className="cursor-pointer px-2 py-1 text-11 text-muted hover:text-primary"
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                >
                    {open ? t("agentInfo.toolkit.showLess") : t("agentInfo.toolkit.showAll", { count: rows.length })}
                </button>
            ) : null}
        </div>
    );
}

function SubTitle({ label, count }: { label: string; count: number }) {
    return (
        <h6 className="mt-2.5 mb-0.5 flex items-baseline gap-1.5 px-2 text-11 font-semibold text-secondary">
            {label}
            <span className="font-normal text-muted">{count}</span>
        </h6>
    );
}

function ServerLine({ row }: { row: ServerRow }) {
    const t = useT();
    const live = row.origin === "molten";
    const stateText = live ? t(`agentInfo.mcpState.${row.state}`) : t(`agentInfo.toolkit.state.${row.state}`);
    const short =
        row.state === "needsapproval" || row.state === "off" ? t(`agentInfo.toolkit.stateShort.${row.state}`) : "";
    return (
        <div className={Line} title={stateText} data-testid="agent-info-server">
            <span
                className={cn(
                    "h-[6px] w-[6px] shrink-0 rounded-full",
                    (live ? McpDot : ConfigDot)[row.state] ?? "bg-secondary"
                )}
            />
            <span
                className={cn(
                    "min-w-0 truncate font-mono text-11",
                    row.state === "off" ? "text-muted" : "text-primary"
                )}
            >
                {row.name}
            </span>
            <span className="min-w-0 truncate text-11 text-muted">
                {[originLabel(t, row.origin, row.plugin), row.transport].filter(Boolean).join(" · ")}
            </span>
            {short ? (
                <span
                    className={cn(
                        "ml-auto shrink-0 text-11",
                        row.state === "needsapproval" ? "text-[var(--mt-state-waiting)]" : "text-muted"
                    )}
                >
                    {short}
                </span>
            ) : null}
        </div>
    );
}

function SkillLine({ skill }: { skill: ToolkitSkill }) {
    const t = useT();
    return (
        <div className={cn(Line, "items-start")} title={skill.description || skill.name} data-testid="agent-info-skill">
            <span className="min-w-0 shrink-0 font-mono text-11 text-primary">{skill.name}</span>
            <span className="min-w-0 flex-1 truncate text-11 text-muted">{skill.description}</span>
            <span className="shrink-0 text-11 text-muted">{originLabel(t, skill.scope, skill.plugin)}</span>
        </div>
    );
}

function PluginChip({ plugin }: { plugin: ToolkitPlugin }) {
    const t = useT();
    return (
        <span
            className={cn(Chip, !plugin.enabled && "opacity-60")}
            title={[plugin.source, t(plugin.enabled ? "agentInfo.toolkit.pluginOn" : "agentInfo.toolkit.pluginOff")]
                .filter(Boolean)
                .join(" · ")}
            data-testid="agent-info-plugin"
        >
            <span className={cn("h-[5px] w-[5px] rounded-full", plugin.enabled ? "bg-success" : "bg-white/20")} />
            {plugin.name}
        </span>
    );
}

// What the agent can use (#1543): MoltenTerm's own MCP servers with their live state, then what the agent's
// configuration declares for this folder, read-only. Choosing what stays usable is #550: until then no "Manage…"
// entry, since a button that does nothing would be a dead end.
function ToolkitSection({ ctx }: { ctx: AgentInfoContext }) {
    const t = useT();
    // The folder the agent started in: the one its configuration is resolved for.
    const cwd = ctx.meta?.["cmd:cwd"] || ctx.pane?.dir || "";
    const load = useAgentToolkit(ctx.info?.agent ?? "", cwd);
    const toolkit = load.toolkit;
    const servers = serverRows(ctx.links, toolkit);
    const skills = toolkit?.skills ?? [];
    const plugins = toolkit?.plugins ?? [];
    const name = agentDisplayName(ctx.info);
    let note: string = null;
    if (load.status === "loading") {
        note = t("agentInfo.toolkit.loading");
    } else if (load.status === "failed") {
        note = t("agentInfo.toolkit.failed");
    } else if (!toolkit?.supported) {
        note = t("agentInfo.toolkit.unsupported", { tool: agentTool(ctx.info) || name });
    } else if (servers.length + skills.length + plugins.length === 0) {
        note = t("agentInfo.toolkit.empty");
    }
    return (
        <section data-testid="agent-info-toolkit">
            <h5 className={SectionTitle}>{t("agentInfo.toolkit.title", { name })}</h5>
            {note ? (
                <div className="px-2 py-1 text-12 text-muted">
                    {load.status === "loading" ? <DominoLoader className="mr-1.5" /> : null}
                    {note}
                </div>
            ) : null}
            {servers.length > 0 ? (
                <>
                    <SubTitle label={t("agentInfo.toolkit.servers")} count={servers.length} />
                    <Preview
                        rows={servers}
                        testId="agent-info-servers"
                        render={(r) => <ServerLine key={`${r.origin}:${r.plugin ?? ""}:${r.name}`} row={r} />}
                    />
                </>
            ) : null}
            {skills.length > 0 ? (
                <>
                    <SubTitle label={t("agentInfo.toolkit.skills")} count={skills.length} />
                    <Preview
                        rows={skills}
                        testId="agent-info-skills"
                        render={(s) => <SkillLine key={`${s.scope}:${s.plugin ?? ""}:${s.name}`} skill={s} />}
                    />
                </>
            ) : null}
            {plugins.length > 0 ? (
                <>
                    <SubTitle label={t("agentInfo.toolkit.plugins")} count={plugins.length} />
                    <div className="flex flex-wrap gap-1 px-2 pt-0.5">
                        {plugins.map((p) => (
                            <PluginChip key={`${p.source ?? ""}:${p.name}`} plugin={p} />
                        ))}
                    </div>
                </>
            ) : null}
            {toolkit?.supported ? (
                <div className="mt-3 px-2 text-11 text-muted">
                    {[t("agentInfo.toolkit.readOnly"), toolkit.online ? t("agentInfo.toolkit.online") : ""]
                        .filter(Boolean)
                        .join(" ")}
                </div>
            ) : null}
        </section>
    );
}

// What works with the agent's tool (FR-AGC-004), the same words as its card at first run.
function WorksSection({ ctx }: { ctx: AgentInfoContext }) {
    const t = useT();
    const agent = ctx.info?.agent;
    if (!agent) {
        return null;
    }
    return (
        <section data-testid="agent-info-works">
            <h5 className={SectionTitle}>
                {t("agentWorks.sectionTitle", { name: agentTool(ctx.info) || agentDisplayName(ctx.info) })}
            </h5>
            <AgentWorks agent={agent} className="px-2 text-12" />
        </section>
    );
}

function CommandsSection({ ctx }: { ctx: AgentInfoContext }) {
    const t = useT();
    const tc = useTCount();
    const rows = commandRows(ctx.companion);
    if (rows.length === 0) {
        return null;
    }
    return (
        <section data-testid="agent-info-commands">
            <h5 className={SectionTitle}>{t("agentInfo.commands")}</h5>
            <div className="flex flex-wrap gap-1">
                {rows.map((c) => (
                    <span key={c.name} className={Chip} title={tc("agentInfo.commandCount", c.count)}>
                        {c.name}
                        {c.count > 1 ? <span className="text-muted">{c.count}</span> : null}
                    </span>
                ))}
            </div>
        </section>
    );
}

async function readSharedPages(workspaceId: string, agentBlockId: string): Promise<SharedPage[]> {
    const workspace = await WOS.reloadWaveObject<Workspace>(WOS.makeORef("workspace", workspaceId));
    const rtn: SharedPage[] = [];
    for (const tabId of workspace?.tabids ?? []) {
        const tab = await WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", tabId));
        for (const blockId of tab?.blockids ?? []) {
            const block = await WOS.reloadWaveObject<Block>(WOS.makeORef("block", blockId));
            if (block?.meta?.view !== MoltentermBrowserView) {
                continue;
            }
            let state: PanelAgentState = null;
            try {
                state = await TabRpcClient.wshRpcCall(
                    BrowserAgentStateCommand,
                    { blockid: blockId },
                    { route: BrowserAgentRouteId, timeout: PageCallTimeoutMs }
                );
            } catch {
                continue;
            }
            const held: AgentTab[] = state?.tabs ?? [];
            const tabs = readBrowserState(block.meta as Record<string, any>, "").tabs;
            rtn.push(...sharedPages(blockId, tabId, agentBlockId, held, tabs));
        }
    }
    return rtn;
}

function usePagesOf(workspaceId: string, agentBlockId: string): SharedPage[] {
    const [pages, setPages] = useState<SharedPage[]>([]);
    useEffect(() => {
        if (!workspaceId || !agentBlockId) {
            return;
        }
        let cancelled = false;
        const load = () =>
            fireAndForget(async () => {
                try {
                    const next = await readSharedPages(workspaceId, agentBlockId);
                    if (!cancelled) {
                        setPages(next);
                    }
                } catch (e) {
                    console.log("agent info: pages", e);
                }
            });
        load();
        const stop = TabActivity.getInstance().every(always(PagesPollMs), load, "agent-info-pages");
        return () => {
            cancelled = true;
            stop();
        };
    }, [workspaceId, agentBlockId]);
    return pages;
}

function PagesSection({ ctx }: { ctx: AgentInfoContext }) {
    const t = useT();
    const pages = usePagesOf(ctx.info?.workspaceid, ctx.blockId);
    if (pages.length === 0) {
        return null;
    }
    const name = agentDisplayName(ctx.info);
    return (
        <section data-testid="agent-info-pages">
            <h5 className={SectionTitle}>{t("agentInfo.pages", { name })}</h5>
            {pages.map((p) => (
                <button
                    key={`${p.panelBlockId}:${p.browserTabId}`}
                    type="button"
                    className={LineButton}
                    title={p.url}
                    onClick={() => {
                        ctx.close();
                        fireAndForget(async () => {
                            await RpcApi.SetMetaCommand(TabRpcClient, {
                                oref: WOS.makeORef("block", p.panelBlockId),
                                meta: { [BrowserActiveMetaKey]: p.browserTabId } as MetaType,
                            });
                            await goToAgent({
                                workspaceid: ctx.info?.workspaceid,
                                tabid: p.tabId,
                                blockid: p.panelBlockId,
                            });
                        });
                    }}
                >
                    <i className={cn(makeIconClass("globe", true), "w-3.5 text-center text-11")} aria-hidden />
                    <span className="min-w-0 truncate text-primary">{p.title}</span>
                    <span className="ml-auto shrink-0 text-11 text-muted">
                        {t(p.shared ? "agentInfo.pageShared" : "agentInfo.pageOpened")}
                    </span>
                </button>
            ))}
        </section>
    );
}

function ViewSection({ ctx }: { ctx: AgentInfoContext }) {
    const t = useT();
    const tc = useTCount();
    const tabId = ctx.info?.tabid ?? "";
    const [tab] = WOS.useWaveObjectValue<Tab>(WOS.makeORef("tab", tabId));
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    if (!tabId || tab == null) {
        return null;
    }
    const panels = tab.blockids?.length ?? 0;
    return (
        <section data-testid="agent-info-view">
            <h5 className={SectionTitle}>{t("agentInfo.view")}</h5>
            <button
                type="button"
                className={LineButton}
                onClick={() => {
                    ctx.close();
                    fireAndForget(() => goToAgent(ctx.info));
                }}
            >
                <i
                    className={cn(makeIconClass(identity.icon, true, { defaultIcon: "square" }), "w-3.5 text-center")}
                    aria-hidden
                />
                <span className="min-w-0 truncate text-primary">{identity.name}</span>
                <span className="ml-auto shrink-0 text-11 text-muted">{tc("agentInfo.panels", panels)}</span>
            </button>
        </section>
    );
}

// The window's sections, in order. A later story appends its own here.
export const AgentInfoSections: AgentInfoSection[] = [
    { key: "facts", column: "top", Component: FactsSection },
    {
        key: "subagents",
        column: "main",
        Component: ({ ctx }) => <SubagentsSection blockId={ctx.blockId} info={ctx.info} companion={ctx.companion} />,
    },
    { key: "linked", column: "main", Component: LinkedSection },
    { key: "pages", column: "main", Component: PagesSection },
    { key: "view", column: "main", Component: ViewSection },
    { key: "commands", column: "main", Component: CommandsSection },
    { key: "works", column: "side", Component: WorksSection },
    { key: "toolkit", column: "side", Component: ToolkitSection },
];

function SectionsOf({ column, ctx }: { column: AgentInfoSection["column"]; ctx: AgentInfoContext }) {
    return (
        <>
            {AgentInfoSections.filter((s) => s.column === column).map(({ key, Component }) => (
                <Component key={key} ctx={ctx} />
            ))}
        </>
    );
}

function AgentHead({ info }: { info: AgentStateInfo }) {
    const look = agentRowLook(info);
    return (
        <div className="flex items-center gap-2.5" data-testid="agent-info-head">
            <AgentAvatar info={info} large />
            <div className="min-w-0">
                <div className="flex items-center gap-2">
                    <b className="text-15 text-primary">{agentDisplayName(info)}</b>
                    {look === "working" ? <WorkingDominoes label={agentStateLabel("working")} /> : null}
                </div>
                <div
                    className={cn(
                        "truncate text-12",
                        look === "waiting"
                            ? "text-[var(--mt-state-waiting)]"
                            : look === "error"
                              ? "text-danger"
                              : "text-muted"
                    )}
                >
                    {[agentStateLabel(info.state), agentDoing(info)]
                        .filter((s, i, all) => s && all.indexOf(s) === i)
                        .join(" · ")}
                </div>
            </div>
        </div>
    );
}

export function AgentInfoWindow({ blockId, onClose }: { blockId: string; onClose: () => void }) {
    const t = useT();
    const live = useAtomValue(AgentStates.getInstance().blockAtom(blockId));
    // An agent that ends while its window is open keeps what was known of it.
    const lastRef = useRef<AgentStateInfo>(live);
    if (live != null) {
        lastRef.current = live;
    }
    const info = live ?? lastRef.current;
    const companion = useCompanionFollow(blockId);
    const links = useAtomValue(AgentLinks.getInstance().blockAtom(blockId));
    const [block] = WOS.useWaveObjectValue<Block>(WOS.makeORef("block", blockId));
    const meta = block?.meta as Record<string, any>;
    const pane = usePaneStatus(meta?.["cmd:cwd"] ?? "", blockId, readWorktreeLink(meta));
    const activeTabId = useAtomValue(atoms.staticTabId);
    const [connectionsOpen, setConnectionsOpen] = useState(false);
    const connectionsRef = useRef<HTMLElement>(null);
    useEffect(() => {
        if (connectionsOpen) {
            connectionsRef.current?.scrollIntoView({ block: "nearest" });
        }
    }, [connectionsOpen]);
    const ctx: AgentInfoContext = useMemo(
        () => ({ blockId, info, companion, links, pane, meta, close: onClose }),
        [blockId, info, companion, links, pane, meta, onClose]
    );
    if (info == null) {
        return null;
    }
    const name = agentDisplayName(info);
    return (
        <DialogFrame
            role="agent-info"
            title={t("agentInfo.title", { name })}
            widthClass="w-[1080px]"
            onBackdrop={onClose}
            onEscape={onClose}
            buttons={
                <>
                    <button
                        type="button"
                        className={cn(PlainButton, "mr-auto")}
                        aria-expanded={connectionsOpen}
                        data-testid="agent-info-connections"
                        onClick={() => setConnectionsOpen(!connectionsOpen)}
                    >
                        {t("agentInfo.connections")}
                    </button>
                    <button type="button" className={PlainButton} data-testid="agent-info-close" onClick={onClose}>
                        {t("agentInfo.close")}
                    </button>
                    {live != null && info.tabid !== activeTabId ? (
                        <button
                            type="button"
                            className={AccentButton}
                            data-testid="agent-info-goto"
                            onClick={() => {
                                onClose();
                                fireAndForget(() => goToAgent(info));
                            }}
                        >
                            {t("agentInfo.goToView")}
                        </button>
                    ) : null}
                </>
            }
        >
            <div className="flex flex-col pb-1" data-testid="agent-info">
                <AgentHead info={info} />
                {live == null ? <div className="mt-2 text-12 text-muted">{t("agentInfo.ended")}</div> : null}
                <div className="mt-3.5">
                    <SectionsOf column="top" ctx={ctx} />
                </div>
                <div className="grid grid-cols-1 gap-x-6 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="min-w-0" data-testid="agent-info-main">
                        <SectionsOf column="main" ctx={ctx} />
                    </div>
                    <div
                        className="min-w-0 min-[900px]:border-l min-[900px]:border-border min-[900px]:pl-6"
                        data-testid="agent-info-side"
                    >
                        <SectionsOf column="side" ctx={ctx} />
                    </div>
                </div>
                {connectionsOpen ? (
                    <section
                        ref={connectionsRef}
                        className="mt-3.5 rounded-6 border border-border p-3 [&>div]:w-full"
                        data-testid="agent-info-connections-panel"
                    >
                        <AgentLinksPanel blockId={blockId} />
                    </section>
                ) : null}
            </div>
        </DialogFrame>
    );
}
