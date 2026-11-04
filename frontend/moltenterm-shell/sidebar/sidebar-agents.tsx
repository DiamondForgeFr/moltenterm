// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The sidebar's agents (FR-SHELL-084): one row per agent of the workspace, between the pinned views and the temporary
// ones. A row says who, what it is doing and its state; its twisty opens its sub-agents, the agents it is linked to,
// then the link to everything about it. Tools, MCP servers, pages and commands stay in that window, not in the tree.

import { getBlockMetaKeyAtom } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { agentFactsLine, agentRunFacts } from "../agent-facts";
import {
    goToAgent,
    useLinkedAgents,
    useSubagentNow,
    useWorkspaceName,
    type LinkedAgentRow,
} from "../agent-info/agent-info-hooks";
import {
    MaxRunningSubRows,
    subagentGroups,
    subagentLeafTitle,
    subagentRows,
    type SubagentRow,
} from "../agent-info/agent-info-model";
import { AgentInfoModel } from "../agent-info/agent-info-store";
import { agentStateLabel, agentStateMessage, agentToolName, type AgentStateInfo } from "../agent-state-model";
import { useCompanionFollow } from "../companion/companion-follow";
import type { CompanionView } from "../companion/companion-model";
import { useT, useTCount } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import { projectIdOfAgent } from "./project-activity";
import { activeProjectOf, agentGroups } from "./sidebar-agents-group";
import {
    agentProjectLabel,
    agentRowLook,
    agentRowTarget,
    type AgentProjectLabel,
    type AgentTreeSection,
} from "./sidebar-agents-model";
import "./sidebar-agents.css";
import { SidebarGlyph } from "./sidebar-icons";
import { projectLabel, type WorkspaceProjectEntry } from "./workspace-projects";

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
function SubagentLeaf({ row, cli, onOpen }: { row: SubagentRow; cli: string; onOpen: () => void }) {
    const t = useT();
    const state = t(`agentInfo.subState.${row.state}`);
    const title = subagentLeafTitle(t, row, cli);
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
    const seen = useAtomValue(model.seenAtom(info.blockid));
    const tree = useAtomValue(model.treeAtom(info.blockid));
    const [allRunning, setAllRunning] = useState(false);
    const rows = subagentRows(companion);
    const now = useSubagentNow(rows);
    const groups = subagentGroups(rows, now, !!companion?.ended, seen);
    const doneCount = groups.lingering.length;
    if (groups.running.length + doneCount === 0) {
        return null;
    }
    const shut = !!tree.shut?.subs;
    const running = allRunning ? groups.running : groups.running.slice(0, MaxRunningSubRows);
    const more = groups.running.length - running.length;
    const open = (s: SubagentRow) => model.openSub(info.blockid, s.id);
    const cli = agentToolName(info);
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
                        <SubagentLeaf key={s.id} row={s} cli={cli} onOpen={() => open(s)} />
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
                    {groups.lingering.map((s) => (
                        <SubagentLeaf key={s.id} row={s} cli={cli} onOpen={() => open(s)} />
                    ))}
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

// The name line: the first name, then the agent's project as a label chip when the workspace holds several (#1746). The
// chip takes the ellipsis; the first name stays whole unless it alone outgrows the row.
export function AgentNameLine({ name, label }: { name: string; label: AgentProjectLabel }) {
    const t = useT();
    if (label == null) {
        return <span className="mt-sb-agent-nm">{name}</span>;
    }
    const title = label.outside
        ? t("sidebar.agents.outsideTitle", { folder: label.text })
        : t("sidebar.agents.projectTitle", { project: label.text });
    return (
        <span className="mt-sb-agent-nm-line">
            <span className="mt-sb-agent-nm">{name}</span>
            <span
                className={cn("mt-sb-agent-proj", label.outside && "is-outside")}
                title={title}
                data-testid="sidebar-agent-project"
                data-outside={label.outside ? "true" : undefined}
            >
                {label.text}
            </span>
        </span>
    );
}

function AgentBlock({
    info,
    active,
    projects,
    grouped,
}: {
    info: AgentStateInfo;
    active: boolean;
    projects: WorkspaceProjectEntry[];
    grouped: boolean;
}) {
    const t = useT();
    const tree = useAtomValue(AgentInfoModel.getInstance().treeAtom(info.blockid));
    const folder = useAtomValue(getBlockMetaKeyAtom(info.blockid, "cmd:cwd")) ?? "";
    const open = !!tree?.open;
    const look = agentRowLook(info);
    const name = agentDisplayName(info);
    const doing = agentDoing(info);
    const label = grouped ? null : agentProjectLabel(folder, projects);
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
                title={[
                    t("sidebar.agents.goTo", { name }),
                    `${agentStateLabel(info.state)}${doing !== agentStateLabel(info.state) ? ` · ${doing}` : ""}`,
                    agentFactsLine(agentRunFacts(info)),
                ]
                    .filter(Boolean)
                    .join("\n")}
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
                    <AgentNameLine name={name} label={label} />
                    <span className="mt-sb-agent-ss">{doing}</span>
                </span>
                {look === "working" ? <WorkingDominoes label={agentStateLabel("working")} /> : null}
            </div>
            {open ? <AgentTree info={info} shut={tree?.shut ?? {}} /> : null}
        </div>
    );
}

// The folder of each agent's terminal, read from its block: the groups follow a terminal that changes folder (#1867).
function useAgentFolders(agents: AgentStateInfo[]): Record<string, string> {
    const ids = (agents ?? []).map((a) => a.blockid).join(",");
    const foldersAtom = useMemo(
        () =>
            atom((get) =>
                Object.fromEntries(
                    ids
                        .split(",")
                        .filter((id) => id !== "")
                        .map((id): [string, string] => [id, get(getBlockMetaKeyAtom(id, "cmd:cwd")) ?? ""])
                )
            ),
        [ids]
    );
    return useAtomValue(foldersAtom);
}

// The separator that opens a project's group (FR-SHELL-084, #1867): a thin rule, and the project's name where the
// temporary views' "Close all" row sits. Not a button.
function AgentGroupSeparator({ name }: { name: string }) {
    return (
        <div className="mt-sb-ag-sep" role="separator" aria-label={name} data-testid="sidebar-agent-group-sep">
            <span className="mt-sb-ag-line" />
            <span className="mt-sb-ag-name text-11 text-muted" data-testid="sidebar-agent-group-name">
                {name}
            </span>
        </div>
    );
}

export function AgentsSection({
    agents,
    activeTabId,
    projects,
    ws,
}: {
    agents: AgentStateInfo[];
    activeTabId: string;
    projects?: WorkspaceProjectEntry[];
    ws?: { meta?: Record<string, any> };
}) {
    const t = useT();
    const tc = useTCount();
    const folders = useAgentFolders(agents);
    if (agents.length === 0) {
        return null;
    }
    const groups = agentGroups(
        agents,
        projects,
        (info) => projectIdOfAgent(ws ?? {}, projects, info, folders[info.blockid] ?? ""),
        activeProjectOf(ws, activeTabId)
    );
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
            {groups == null ? (
                <div className="flex flex-col gap-px">
                    {agents.map((a) => (
                        <AgentBlock
                            key={a.blockid}
                            info={a}
                            active={a.tabid === activeTabId}
                            projects={projects}
                            grouped={false}
                        />
                    ))}
                </div>
            ) : (
                groups.map((g) => (
                    <div
                        key={g.project?.id ?? "none"}
                        className="mt-sb-ag-group flex flex-col gap-px"
                        data-testid="sidebar-agent-group"
                        data-project={g.project?.id ?? undefined}
                    >
                        <AgentGroupSeparator
                            name={g.project ? projectLabel(g.project) : t("sidebar.agents.noProject")}
                        />
                        {g.agents.map((a) => (
                            <AgentBlock
                                key={a.blockid}
                                info={a}
                                active={a.tabid === activeTabId}
                                projects={projects}
                                grouped
                            />
                        ))}
                    </div>
                ))
            )}
        </div>
    );
}
