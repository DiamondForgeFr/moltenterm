// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sidebar's agents (FR-SHELL-084): one row per agent of the workspace, between the pinned views and the temporary
// ones. A row says who, what it is doing and its state; its twisty opens its sub-agents, the agents it is linked to,
// then the link to everything about it. Tools, MCP servers, pages and commands stay in that window, not in the tree.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { goToAgent, useLinkedAgents, useWorkspaceName, type LinkedAgentRow } from "../agent-info/agent-info-hooks";
import {
    MaxRunningSubRows,
    parentTurnStart,
    subagentGroups,
    subagentKindKey,
    subagentRows,
    type SubagentRow,
} from "../agent-info/agent-info-model";
import { AgentInfoModel } from "../agent-info/agent-info-store";
import { agentStateLabel, agentStateMessage, type AgentStateInfo } from "../agent-state-model";
import { useCompanionFollow } from "../companion/companion-follow";
import type { CompanionView } from "../companion/companion-model";
import { useT, useTCount } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import { agentRowLook, agentRowTarget, type AgentTreeSection } from "./sidebar-agents-model";
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

// A sub-agent row (FR-SHELL-104): its description alone, so a long one keeps the width; its state is a mark, never a
// word (F26). One loader only: the agent's own row, which works while its sub-agents do (#1092); the section's header
// carries it only when that row does not (the agent waits on a question while its sub-agents run).
function SubagentLeaf({ row, onOpen }: { row: SubagentRow; onOpen: () => void }) {
    const t = useT();
    const kindKey = subagentKindKey(row.kind);
    const kind = kindKey ? t(kindKey) : row.kind;
    const state = t(`agentInfo.subState.${row.state}`);
    const title = [row.name, [state, kind, row.model].filter(Boolean).join(" · "), t("agentInfo.sub.open")]
        .filter(Boolean)
        .join("\n");
    return (
        <button
            type="button"
            className={cn("mt-sb-leaf", `is-sub-${row.state}`)}
            title={title}
            data-testid="sidebar-agent-sub"
            data-state={row.state}
            onClick={onOpen}
        >
            <AgentGlyph name="sub" />
            <span className="mt-sb-leaf-t">{row.name}</span>
            {row.state === "done" || row.state === "error" || row.state === "idle" ? (
                <span className="mt-sb-sub-mark" aria-label={state} />
            ) : null}
        </button>
    );
}

function SubagentsGroup({ info, companion }: { info: AgentStateInfo; companion: CompanionView }) {
    const t = useT();
    const tc = useTCount();
    const model = AgentInfoModel.getInstance();
    const clearedAll = useAtomValue(model.clearedSubsAtom);
    const trees = useAtomValue(model.treesAtom);
    const [allRunning, setAllRunning] = useState(false);
    const [doneOpen, setDoneOpen] = useState(false);
    const rows = subagentRows(companion);
    const groups = subagentGroups(rows, parentTurnStart(companion), !!companion?.ended, clearedAll[info.blockid]);
    const doneCount = groups.recent.length + groups.folded.length;
    if (groups.running.length + doneCount === 0) {
        return null;
    }
    const shut = !!trees[info.blockid]?.shut?.subs;
    const running = allRunning ? groups.running : groups.running.slice(0, MaxRunningSubRows);
    const more = groups.running.length - running.length;
    const open = (s: SubagentRow) => model.openSub(info.blockid, s.id);
    const counts = [
        groups.running.length > 0 ? tc("agentInfo.sub.running", groups.running.length) : "",
        doneCount > 0 ? tc("agentInfo.sub.done", doneCount) : "",
    ]
        .filter(Boolean)
        .join(" · ");
    return (
        <>
            <button
                type="button"
                className={cn("mt-sb-tl", shut && "is-shut")}
                aria-expanded={!shut}
                data-testid="sidebar-agent-section-subs"
                onClick={() => model.toggleSection(info.blockid, "subs")}
            >
                <SidebarGlyph name="chev" size={10} />
                <span title={t("agentInfo.subagents")}>{t("agentInfo.subagents")}</span>
                {groups.working > 0 && agentRowLook(info) !== "working" ? (
                    <WorkingDominoes label={agentStateLabel("working")} />
                ) : null}
                <span className="mt-sb-tl-n" data-testid="sidebar-agent-subs-count">
                    {counts}
                </span>
            </button>
            {shut ? null : (
                <>
                    {running.map((s) => (
                        <SubagentLeaf key={s.id} row={s} onOpen={() => open(s)} />
                    ))}
                    {more > 0 ? (
                        <button
                            type="button"
                            className="mt-sb-leaf mt-sb-more"
                            data-testid="sidebar-agent-subs-more"
                            onClick={() => setAllRunning(true)}
                        >
                            {t("agentInfo.sub.more", { count: more })}
                        </button>
                    ) : null}
                    {groups.recent.map((s) => (
                        <SubagentLeaf key={s.id} row={s} onOpen={() => open(s)} />
                    ))}
                    {groups.folded.length > 0 ? (
                        <button
                            type="button"
                            className={cn("mt-sb-leaf mt-sb-fold", !doneOpen && "is-shut")}
                            aria-expanded={doneOpen}
                            data-testid="sidebar-agent-subs-done"
                            onClick={() => setDoneOpen(!doneOpen)}
                        >
                            <SidebarGlyph name="chev" size={10} />
                            <span className="mt-sb-leaf-t">
                                {t("agentInfo.sub.doneFold", { count: groups.folded.length })}
                            </span>
                        </button>
                    ) : null}
                    {doneOpen
                        ? groups.folded.map((s) => <SubagentLeaf key={s.id} row={s} onOpen={() => open(s)} />)
                        : null}
                    {doneCount > 0 ? (
                        <button
                            type="button"
                            className="mt-sb-sub-clear"
                            data-testid="sidebar-agent-subs-clear"
                            onClick={() =>
                                model.clearDoneSubs(
                                    info.blockid,
                                    [...groups.recent, ...groups.folded].map((s) => s.id)
                                )
                            }
                        >
                            {t("agentInfo.sub.clearDone")}
                        </button>
                    ) : null}
                </>
            )}
        </>
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
    const links = useLinkedAgents(info.blockid);
    const name = agentDisplayName(info);
    const model = AgentInfoModel.getInstance();
    return (
        <div className="mt-sb-tree" data-testid="sidebar-agent-tree">
            <SubagentsGroup info={info} companion={companion} />
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

function AgentBlock({ info, active }: { info: AgentStateInfo; active: boolean }) {
    const t = useT();
    const trees = useAtomValue(AgentInfoModel.getInstance().treesAtom);
    const tree = trees[info.blockid];
    const open = !!tree?.open;
    const look = agentRowLook(info);
    const name = agentDisplayName(info);
    const doing = agentDoing(info);
    const go = () => fireAndForget(() => goToAgent(agentRowTarget(info)));
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
            </div>
            {open ? <AgentTree info={info} shut={tree?.shut ?? {}} /> : null}
        </div>
    );
}

export function AgentsSection({ agents, activeTabId }: { agents: AgentStateInfo[]; activeTabId: string }) {
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
                {agents.map((a) => (
                    <AgentBlock key={a.blockid} info={a} active={a.tabid === activeTabId} />
                ))}
            </div>
        </div>
    );
}
