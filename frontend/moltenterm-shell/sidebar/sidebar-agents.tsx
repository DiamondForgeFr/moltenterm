// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sidebar's agents (FR-SHELL-084): one row per agent of the workspace, between the pinned views and the temporary
// ones. A row says who, what it is doing and its state; its twisty opens its sub-agents, the agents it is linked to,
// then the link to everything about it. Tools, MCP servers, pages and commands stay in that window, not in the tree.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { goToAgent, useLinkedAgents, useWorkspaceName, type LinkedAgentRow } from "../agent-info/agent-info-hooks";
import { subagentRows, type SubagentRow } from "../agent-info/agent-info-model";
import { AgentInfoModel } from "../agent-info/agent-info-store";
import { agentStateLabel, agentStateMessage, type AgentStateInfo } from "../agent-state-model";
import { useCompanionFollow } from "../companion/companion-follow";
import { useT, useTCount } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import { agentRowLook, type AgentTreeSection } from "./sidebar-agents-model";
import "./sidebar-agents.css";
import { SidebarGlyph } from "./sidebar-icons";

const AgentPaths = {
    sub: (
        <>
            <circle cx="7" cy="6" r="2.5" />
            <path d="M7 8.5V15a3 3 0 0 0 3 3h5" />
            <circle cx="17.5" cy="18" r="2.5" />
        </>
    ),
    out: <path d="M5 12h13M13 7l5 5-5 5" />,
    in: <path d="M19 12H6M11 7l-5 5 5 5" />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
};

export function AgentGlyph({ name, size = 13 }: { name: keyof typeof AgentPaths; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0"
        >
            {AgentPaths[name]}
        </svg>
    );
}

// The suite's falling dominoes in white at about 60 %, the working state of an agent row (never a ring).
export function WorkingDominoes({ label }: { label?: string }) {
    return <DominoLoader className="mt-sb-agent-dom" label={label} />;
}

export function agentInitial(info: AgentStateInfo): string {
    const name = (info?.firstname || info?.agentname || info?.agent || "?").trim();
    return (Array.from(name)[0] ?? "?").toUpperCase();
}

export function AgentAvatar({ info, large }: { info: AgentStateInfo; large?: boolean }) {
    const look = agentRowLook(info);
    return (
        <span className={cn("mt-sb-av", `is-${look}`, large && "is-large")} aria-hidden>
            {agentInitial(info)}
        </span>
    );
}

// The second line: what MoltenTerm or the agent says it is doing, else its state.
export function agentDoing(info: AgentStateInfo): string {
    return agentStateMessage(info) || agentStateLabel(info?.state ?? "idle");
}

function SectionTitle({
    blockId,
    section,
    label,
    count,
    shut,
}: {
    blockId: string;
    section: AgentTreeSection;
    label: string;
    count: number;
    shut: boolean;
}) {
    return (
        <button
            type="button"
            className={cn("mt-sb-tl", shut && "is-shut")}
            aria-expanded={!shut}
            data-testid={`sidebar-agent-section-${section}`}
            onClick={() => AgentInfoModel.getInstance().toggleSection(blockId, section)}
        >
            <SidebarGlyph name="chev" size={10} />
            <span>{label}</span>
            <span className="mt-sb-tl-n">{count}</span>
        </button>
    );
}

function SubagentLeaf({ row, onOpen }: { row: SubagentRow; onOpen: () => void }) {
    const t = useT();
    const title = [row.name, [row.kind, row.model].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
    return (
        <button type="button" className="mt-sb-leaf" title={title} data-testid="sidebar-agent-sub" onClick={onOpen}>
            <AgentGlyph name="sub" />
            <span className="mt-sb-leaf-t">{row.name}</span>
            {row.state === "working" ? (
                <WorkingDominoes />
            ) : (
                <span className="mt-sb-leaf-s">{t(`agentInfo.subState.${row.state}`)}</span>
            )}
        </button>
    );
}

function LinkedLeaf({ row, workspaceId }: { row: LinkedAgentRow; workspaceId: string }) {
    const t = useT();
    const otherWorkspace = row.workspaceId && row.workspaceId !== workspaceId ? row.workspaceId : "";
    const wsName = useWorkspaceName(otherWorkspace);
    const what = [row.goal || t(row.dir === "out" ? "agentInfo.link.out" : "agentInfo.link.in"), wsName]
        .filter(Boolean)
        .join(" · ");
    const title = t(row.dir === "out" ? "agentInfo.link.outTitle" : "agentInfo.link.inTitle", {
        name: row.name,
        count: row.count,
    });
    const reachable = row.info != null;
    return (
        <button
            type="button"
            className={cn("mt-sb-leaf", !reachable && "is-static")}
            title={reachable ? `${title}\n${t("agentInfo.link.goTo", { name: row.name })}` : title}
            disabled={!reachable}
            data-testid="sidebar-agent-link"
            onClick={() => reachable && fireAndForget(() => goToAgent(row.info))}
        >
            <AgentGlyph name={row.dir} />
            <span className="mt-sb-leaf-t">
                {row.name} <span className="mt-sb-leaf-what">{what}</span>
            </span>
        </button>
    );
}

function AgentTree({ info, shut }: { info: AgentStateInfo; shut: Partial<Record<AgentTreeSection, boolean>> }) {
    const t = useT();
    const companion = useCompanionFollow(info.blockid);
    const subs = subagentRows(companion);
    const links = useLinkedAgents(info.blockid);
    const name = agentDisplayName(info);
    const model = AgentInfoModel.getInstance();
    return (
        <div className="mt-sb-tree" data-testid="sidebar-agent-tree">
            {subs.length > 0 ? (
                <>
                    <SectionTitle
                        blockId={info.blockid}
                        section="subs"
                        label={t("agentInfo.subagents")}
                        count={subs.length}
                        shut={!!shut?.subs}
                    />
                    {shut?.subs
                        ? null
                        : subs.map((s) => <SubagentLeaf key={s.id} row={s} onOpen={() => model.open(info.blockid)} />)}
                </>
            ) : null}
            {links.length > 0 ? (
                <>
                    <SectionTitle
                        blockId={info.blockid}
                        section="links"
                        label={t("agentInfo.linked")}
                        count={links.length}
                        shut={!!shut?.links}
                    />
                    {shut?.links
                        ? null
                        : links.map((l) => (
                              <LinkedLeaf key={`${l.dir}:${l.blockId}`} row={l} workspaceId={info.workspaceid} />
                          ))}
                </>
            ) : null}
            <button
                type="button"
                className="mt-sb-cta"
                data-testid="sidebar-agent-everything"
                onClick={() => model.open(info.blockid)}
            >
                {t("agentInfo.everything", { name })}
                <AgentGlyph name="arrow" size={12} />
            </button>
        </div>
    );
}

export function agentDisplayName(info: AgentStateInfo): string {
    return (info?.firstname || info?.agentname || info?.agent || "").trim();
}

// What the row of an agent that owns a temporary view adds: that view's menu and its close, as its row had.
export type OwnedViewProps = {
    onContextMenu: (e: React.MouseEvent) => void;
    close: React.ReactNode;
};

function AgentBlock({ info, active, owned }: { info: AgentStateInfo; active: boolean; owned?: OwnedViewProps }) {
    const t = useT();
    const trees = useAtomValue(AgentInfoModel.getInstance().treesAtom);
    const tree = trees[info.blockid];
    const open = !!tree?.open;
    const look = agentRowLook(info);
    const name = agentDisplayName(info);
    const doing = agentDoing(info);
    const go = () => fireAndForget(() => goToAgent(info));
    const toggleLabel = t(open ? "sidebar.agents.collapse" : "sidebar.agents.expand", { name });
    return (
        <div
            className={cn("mt-sb-agent", !open && "is-closed")}
            data-testid="sidebar-agent"
            data-block-id={info.blockid}
        >
            <div
                role="button"
                tabIndex={0}
                className={cn("mt-sb-row mt-sb-arow", `is-${look}`, active && "is-on")}
                aria-current={active ? "page" : undefined}
                title={`${t("sidebar.agents.goTo", { name })}\n${agentStateLabel(info.state)}${
                    doing !== agentStateLabel(info.state) ? ` · ${doing}` : ""
                }`}
                data-testid="sidebar-agent-row"
                data-state={look}
                onClick={go}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        go();
                    } else if (e.key === "ArrowRight" && !open) {
                        AgentInfoModel.getInstance().toggleTree(info.blockid);
                    } else if (e.key === "ArrowLeft" && open) {
                        AgentInfoModel.getInstance().toggleTree(info.blockid);
                    }
                }}
                onContextMenu={owned?.onContextMenu}
            >
                <button
                    type="button"
                    className="mt-sb-tw"
                    aria-label={toggleLabel}
                    title={toggleLabel}
                    aria-expanded={open}
                    data-testid="sidebar-agent-twisty"
                    onClick={(e) => {
                        e.stopPropagation();
                        AgentInfoModel.getInstance().toggleTree(info.blockid);
                    }}
                >
                    <SidebarGlyph name="chev" size={13} />
                </button>
                <AgentAvatar info={info} />
                <span className="mt-sb-agent-tx">
                    <span className="mt-sb-agent-nm">{name}</span>
                    <span className="mt-sb-agent-ss">{doing}</span>
                </span>
                {look === "working" ? <WorkingDominoes label={agentStateLabel("working")} /> : null}
                {owned ? (
                    <span
                        className="mt-sb-hover-ctl flex shrink-0 items-center"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {owned.close}
                    </span>
                ) : null}
            </div>
            {open ? <AgentTree info={info} shut={tree?.shut ?? {}} /> : null}
        </div>
    );
}

// Wraps the row of an agent owning a temporary view with that view's actions (the sidebar's own hook).
export type OwnedViewWrap = React.ComponentType<{
    tabId: string;
    active: boolean;
    children: (owned: OwnedViewProps) => React.ReactNode;
}>;

export function AgentsSection({
    agents,
    activeTabId,
    ownedViews,
    OwnedView,
}: {
    agents: AgentStateInfo[];
    activeTabId: string;
    // The temporary view each agent owns, by its terminal.
    ownedViews: Map<string, string>;
    OwnedView: OwnedViewWrap;
}) {
    const t = useT();
    const tc = useTCount();
    if (agents.length === 0) {
        return null;
    }
    const live = agents.filter((a) => {
        const look = agentRowLook(a);
        return look === "working" || look === "waiting" || look === "error";
    }).length;
    return (
        <div className="flex shrink-0 flex-col" data-testid="sidebar-agents">
            <div className="flex items-center gap-1.5 px-1 pt-1.5 pb-0.5 text-11 tracking-[0.07em] text-muted uppercase">
                <span>{t("sidebar.agents.title")}</span>
                <span className="ml-auto tracking-normal normal-case" data-testid="sidebar-agents-count">
                    {live > 0 ? tc("sidebar.agents.active", live) : t("sidebar.agents.resting")}
                </span>
            </div>
            <div className="flex flex-col gap-px">
                {agents.map((a) => {
                    const active = a.tabid === activeTabId;
                    const tabId = ownedViews.get(a.blockid);
                    if (tabId == null) {
                        return <AgentBlock key={a.blockid} info={a} active={active} />;
                    }
                    return (
                        <OwnedView key={a.blockid} tabId={tabId} active={active}>
                            {(owned) => <AgentBlock info={a} active={active} owned={owned} />}
                        </OwnedView>
                    );
                })}
            </div>
        </div>
    );
}
