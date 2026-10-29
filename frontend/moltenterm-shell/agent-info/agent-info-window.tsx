// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Everything about <agent>" (FR-SHELL-084): one window, from the link under an agent in the sidebar and from the plug
// in its terminal's header. It shows what MoltenTerm knows of the agent, for Claude Code and Codex alike: its tool,
// model and effort, where it works and since when, its sub-agents, the agents it is linked to, its MoltenTerm MCP
// servers, the commands it ran, the pages shared with it and its view. Sections are a list (AgentInfoSections), so
// later stories add theirs (cost, context used) without touching the others; a section with nothing to show is left out.

import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentLinksPanel } from "../agent-links/agent-links-menu";
import { BlockLinks } from "../agent-links/agent-links-model";
import { AgentLinks } from "../agent-links/agent-links-store";
import { agentEffortPart, agentModelPart, agentStateLabel, type AgentStateInfo } from "../agent-state-model";
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
import { always, TabActivity } from "../tab-activity";
import { useTabIdentity } from "../tab-identity-ui";
import { pathBaseName, readWorkspaceProject } from "../workspace-project";
import { readWorktreeLink } from "../worktree-model";
import { goToAgent, useLinkedAgents, useWorkspaceName, type LinkedAgentRow } from "./agent-info-hooks";
import { agentTool, mcpServerRows, sharedPages, startedAgo, subagentRows, type SharedPage } from "./agent-info-model";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";
const AccentButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";
const SectionTitle = "mt-3.5 mb-1.5 text-11 font-semibold tracking-[0.07em] text-muted uppercase";
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
    close: () => void;
};

export type AgentInfoSection = {
    key: string;
    Component: React.ComponentType<{ ctx: AgentInfoContext }>;
};

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
    if (!value) {
        return null;
    }
    return (
        <div className="min-w-0 rounded-8 bg-white/[0.05] px-[11px] py-[9px]" title={title ?? value}>
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
            <Fact label={t("agentInfo.fact.tool")} value={agentTool(info)} />
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

function SubagentsSection({ ctx }: { ctx: AgentInfoContext }) {
    const t = useT();
    const rows = subagentRows(ctx.companion);
    if (rows.length === 0) {
        return null;
    }
    return (
        <section data-testid="agent-info-subagents">
            <h5 className={SectionTitle}>{t("agentInfo.subagents")}</h5>
            {rows.map((s) => (
                <div key={s.id} className={Line}>
                    <AgentGlyph name="sub" size={14} />
                    <span className="min-w-0 truncate text-primary">{s.name}</span>
                    <span className="shrink-0 truncate text-muted">
                        {[s.kind !== s.name ? s.kind : "", s.model].filter(Boolean).join(" · ")}
                    </span>
                    <span className="ml-auto shrink-0 text-11 text-muted">
                        {s.state === "working" ? <WorkingDominoes /> : t(`agentInfo.subState.${s.state}`)}
                    </span>
                </div>
            ))}
        </section>
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

function McpSection({ ctx }: { ctx: AgentInfoContext }) {
    const t = useT();
    const rows = mcpServerRows(ctx.links);
    if (rows.length === 0) {
        return null;
    }
    return (
        <section data-testid="agent-info-mcp">
            <h5 className={SectionTitle}>{t("agentInfo.mcp")}</h5>
            <div className="flex flex-wrap gap-1">
                {rows.map((r) => (
                    <span key={r.server} className={Chip} title={t(`agentInfo.mcpState.${r.state ?? "connected"}`)}>
                        <span className={cn("h-[5px] w-[5px] rounded-full", McpDot[r.state] ?? "bg-secondary")} />
                        {r.server}
                    </span>
                ))}
            </div>
        </section>
    );
}

function CommandsSection({ ctx }: { ctx: AgentInfoContext }) {
    const t = useT();
    const commands = ctx.companion?.commands ?? [];
    if (commands.length === 0) {
        return null;
    }
    return (
        <section data-testid="agent-info-commands">
            <h5 className={SectionTitle}>{t("agentInfo.commands")}</h5>
            <div className="flex flex-wrap gap-1">
                {commands.map((c) => (
                    <span key={c} className={Chip}>
                        {c}
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
    { key: "facts", Component: FactsSection },
    { key: "subagents", Component: SubagentsSection },
    { key: "linked", Component: LinkedSection },
    { key: "mcp", Component: McpSection },
    { key: "commands", Component: CommandsSection },
    { key: "pages", Component: PagesSection },
    { key: "view", Component: ViewSection },
];

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
                        look === "waiting" ? "text-[var(--mt-state-waiting)]" : look === "error" ? "text-danger" : "text-muted"
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
    const [connectionsOpen, setConnectionsOpen] = useState(false);
    const connectionsRef = useRef<HTMLElement>(null);
    useEffect(() => {
        if (connectionsOpen) {
            connectionsRef.current?.scrollIntoView({ block: "nearest" });
        }
    }, [connectionsOpen]);
    const ctx: AgentInfoContext = useMemo(
        () => ({ blockId, info, companion, links, pane, close: onClose }),
        [blockId, info, companion, links, pane, onClose]
    );
    if (info == null) {
        return null;
    }
    const name = agentDisplayName(info);
    return (
        <DialogFrame
            role="agent-info"
            title={t("agentInfo.title", { name })}
            widthClass="w-[640px]"
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
                    {live != null ? (
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
                    {AgentInfoSections.map(({ key, Component }) => (
                        <Component key={key} ctx={ctx} />
                    ))}
                </div>
                {connectionsOpen ? (
                    <section
                        ref={connectionsRef}
                        className="mt-3.5 rounded-8 border border-border p-3 [&>div]:w-full"
                        data-testid="agent-info-connections-panel"
                    >
                        <AgentLinksPanel blockId={blockId} />
                    </section>
                ) : null}
                <div className="mt-3.5 text-11 text-muted">{t("agentInfo.moreLater")}</div>
            </div>
        </DialogFrame>
    );
}
