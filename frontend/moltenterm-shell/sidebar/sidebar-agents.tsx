// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The sidebar's agents (FR-SHELL-084): one row per agent of the workspace, between the pinned views and the temporary
// ones. A row says who, what it is doing and its state; its twisty opens its sub-agents, the agents it is linked to,
// then the link to everything about it. Tools, MCP servers, pages and commands stay in that window, not in the tree.
// Any of these rows can carry the developer's own short note (agent-note-ui.tsx, #2008).

import { ContextMenuModel } from "@/app/store/contextmenu";
import { getBlockMetaKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useMemo, useRef, useState } from "react";
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
import { t, useT, useTCount } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import { noteKey } from "./agent-note-model";
import { AgentNotesModel } from "./agent-note-store";
import {
    AgentNoteField,
    AgentNoteFull,
    agentNoteMenuItems,
    AgentNoteTag,
    showAgentNoteMenu,
    useAgentNote,
    useNoteEditing,
    useNoteRefocus,
    type NoteSubject,
} from "./agent-note-ui";
import { projectIdOfAgent } from "./project-activity";
import { agentGroups } from "./sidebar-agents-group";
import {
    agentProjectLabel,
    agentRowLook,
    agentRowTarget,
    type AgentProjectLabel,
    type AgentTreeSection,
} from "./sidebar-agents-model";
import { arrivalOrder, canMove, orderAgents } from "./sidebar-agents-order";
import { AgentOrderModel } from "./sidebar-agents-order-store";
import "./sidebar-agents.css";
import { SidebarGlyph } from "./sidebar-icons";
import { projectLabel, type WorkspaceProjectEntry } from "./workspace-projects";

// The same threshold as the views' drag (sidebar-drag.ts), without loading the views' store.
const AgentDragThresholdPx = 4;

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
export function SubagentLeaf({
    row,
    cli,
    onOpen,
    workspaceId,
    blockId,
}: {
    row: SubagentRow;
    cli: string;
    onOpen: () => void;
    workspaceId: string;
    blockId: string;
}) {
    const t = useT();
    const state = t(`agentInfo.subState.${row.state}`);
    const title = subagentLeafTitle(t, row, cli);
    const subject: NoteSubject = {
        kind: "sub",
        at: `sub:${noteKey(blockId, row.id)}`,
        workspaceId,
        key: noteKey(blockId, row.id),
        name: row.name,
    };
    const note = useAgentNote(workspaceId, subject.key);
    const editing = useNoteEditing(subject.at);
    const ref = useRef<HTMLButtonElement>(null);
    useNoteRefocus(subject.at, editing, ref);
    if (editing) {
        return (
            <div className="mt-sb-leaf is-noting">
                <AgentGlyph name="sub" />
                <AgentNoteField at={subject.at} name={row.name} initial={note} />
            </div>
        );
    }
    return (
        <button
            ref={ref}
            type="button"
            className={cn("mt-sb-leaf", `is-sub-${row.state}`)}
            title={title}
            data-testid="sidebar-agent-sub"
            data-state={row.state}
            onClick={onOpen}
            onContextMenu={(e) => showAgentNoteMenu(e, subject)}
        >
            <AgentGlyph name="sub" />
            <span className="mt-sb-leaf-t">{row.name}</span>
            {note !== "" ? <AgentNoteTag text={note} /> : null}
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
                        <SubagentLeaf
                            key={s.id}
                            row={s}
                            cli={cli}
                            onOpen={() => open(s)}
                            workspaceId={info.workspaceid}
                            blockId={info.blockid}
                        />
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
                        <SubagentLeaf
                            key={s.id}
                            row={s}
                            cli={cli}
                            onOpen={() => open(s)}
                            workspaceId={info.workspaceid}
                            blockId={info.blockid}
                        />
                    ))}
                </>
            )}
        </>
    );
}

// The linked agent's own note: the one its row under Agents shows, kept in its workspace.
export function LinkedLeaf({
    row,
    workspaceId,
    parentId,
}: {
    row: LinkedAgentRow;
    workspaceId: string;
    parentId: string;
}) {
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
    const subject: NoteSubject = {
        kind: "linked",
        at: `link:${parentId}:${row.dir}:${row.blockId}`,
        workspaceId: row.workspaceId || workspaceId,
        key: noteKey(row.blockId),
        name: row.name,
    };
    const note = useAgentNote(subject.workspaceId, subject.key);
    const editing = useNoteEditing(subject.at);
    const ref = useRef<HTMLButtonElement>(null);
    useNoteRefocus(subject.at, editing, ref);
    if (editing) {
        return (
            <div className="mt-sb-leaf is-noting">
                <AgentGlyph name={row.dir} />
                <AgentNoteField at={subject.at} name={row.name} initial={note} />
            </div>
        );
    }
    return (
        <button
            ref={ref}
            type="button"
            className={cn("mt-sb-leaf", !reachable && "is-static")}
            title={reachable ? `${title}\n${t("agentInfo.link.goTo", { name: row.name })}` : title}
            aria-disabled={!reachable || undefined}
            data-testid="sidebar-agent-link"
            onClick={() => reachable && fireAndForget(() => goToAgent(row.info))}
            onContextMenu={(e) => showAgentNoteMenu(e, subject)}
        >
            <AgentGlyph name={row.dir} />
            <span className="mt-sb-leaf-t">
                {row.name} <span className="mt-sb-leaf-what">{what}</span>
            </span>
            {note !== "" ? <AgentNoteTag text={note} /> : null}
        </button>
    );
}

function AgentTree({ info, shut }: { info: AgentStateInfo; shut: Partial<Record<AgentTreeSection, boolean>> }) {
    const t = useT();
    const companion = useCompanionFollow(info.blockid);
    const links = useLinkedAgents(info.blockid);
    const name = agentDisplayName(info);
    const model = AgentInfoModel.getInstance();
    const note: NoteSubject = {
        kind: "agent",
        at: `tree:${info.blockid}`,
        workspaceId: info.workspaceid,
        key: noteKey(info.blockid),
        name,
    };
    return (
        <div className="mt-sb-tree" data-testid="sidebar-agent-tree">
            <AgentNoteFull subject={note} />
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
                              <LinkedLeaf
                                  key={`${l.dir}:${l.blockId}`}
                                  row={l}
                                  workspaceId={info.workspaceid}
                                  parentId={info.blockid}
                              />
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

// Where an agent row stands in the developer's order (#2296): the ids of the list as shown and of its project group,
// the drop mark a drag puts on it, and the drag's hooks.
type AgentRowOrder = {
    shown: string[];
    group: string[];
    drop: "before" | "after" | null;
    dragged: boolean;
    startDrag: (e: React.MouseEvent, id: string, group: string[]) => void;
    takeClick: (id: string) => boolean;
};

// Move up and Move down first when the project holds other agents, then the note's items (#2008).
export function agentRowMenuItems(
    subject: NoteSubject,
    hasNote: boolean,
    order: { shown: string[]; group: string[] },
    blockId: string
): ContextMenuItem[] {
    const notes = agentNoteMenuItems(subject, hasNote);
    if ((order?.group?.length ?? 0) < 2) {
        return notes;
    }
    const model = AgentOrderModel.getInstance();
    const step = (delta: -1 | 1): ContextMenuItem => ({
        label: t(delta < 0 ? "sidebar.agents.order.up" : "sidebar.agents.order.down"),
        icon: delta < 0 ? "arrow-up" : "arrow-down",
        enabled: canMove(order.group, blockId, delta),
        click: () => model.moveStep(subject.workspaceId, order.shown, order.group, blockId, delta),
    });
    return [step(-1), step(1), { type: "separator" }, ...notes];
}

function showAgentRowMenu(e: React.MouseEvent, subject: NoteSubject, order: AgentRowOrder, blockId: string) {
    const hasNote = globalStore.get(AgentNotesModel.getInstance().noteAtom(subject.workspaceId, subject.key)) !== "";
    ContextMenuModel.getInstance().showContextMenu(agentRowMenuItems(subject, hasNote, order, blockId), e);
}

// The row under the pointer a drag may land on: one of the dragged agent's own group, never another project's.
function agentDropAt(x: number, y: number, group: string[], dragged: string): { target: string; after: boolean } {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-agent-drop]");
    const target = el?.getAttribute("data-block-id");
    if (target == null || target === dragged || !group.includes(target)) {
        return null;
    }
    const rect = el.getBoundingClientRect();
    return { target, after: y > rect.top + rect.height / 2 };
}

type AgentDrag = { id: string; target: string; after: boolean };

// Dragging an agent row within its project group: past a few pixels it follows the pointer; on release it moves the
// agent, and the click that ends the drag does not open its view.
function useAgentDrag(workspaceId: string, shown: string[]) {
    const [drag, setDrag] = useState<AgentDrag>(null);
    const ended = useRef<string>(null);
    const startDrag = (e: React.MouseEvent, id: string, group: string[]) => {
        if (e.button !== 0 || group.length < 2) {
            return;
        }
        const startX = e.clientX;
        const startY = e.clientY;
        let started = false;
        let hit: { target: string; after: boolean } = null;
        const onMove = (ev: MouseEvent) => {
            if (!started) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < AgentDragThresholdPx) {
                    return;
                }
                started = true;
            }
            hit = agentDropAt(ev.clientX, ev.clientY, group, id);
            setDrag({ id, target: hit?.target ?? null, after: hit?.after ?? false });
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            setDrag(null);
            if (!started) {
                return;
            }
            ended.current = id;
            if (hit != null) {
                AgentOrderModel.getInstance().moveTo(workspaceId, shown, group, id, hit.target, hit.after);
            }
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    };
    const takeClick = (id: string) => {
        const taken = ended.current === id;
        ended.current = null;
        return taken;
    };
    return { drag, startDrag, takeClick };
}

function AgentBlock({
    info,
    active,
    projects,
    grouped,
    order,
}: {
    info: AgentStateInfo;
    active: boolean;
    projects: WorkspaceProjectEntry[];
    grouped: boolean;
    order: AgentRowOrder;
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
    const subject: NoteSubject = {
        kind: "agent",
        at: `row:${info.blockid}`,
        workspaceId: info.workspaceid,
        key: noteKey(info.blockid),
        name,
    };
    const note = useAgentNote(subject.workspaceId, subject.key);
    const editing = useNoteEditing(subject.at);
    const rowRef = useRef<HTMLDivElement>(null);
    useNoteRefocus(subject.at, editing, rowRef);
    return (
        <div
            className={cn("mt-sb-agent", !open && "is-closed", order.dragged && "mt-sb-dragged")}
            data-testid="sidebar-agent"
            data-block-id={info.blockid}
            data-agent-drop=""
        >
            <div
                ref={rowRef}
                role="button"
                tabIndex={0}
                className={cn(
                    "mt-sb-row mt-sb-arow",
                    `is-${look}`,
                    active && "is-on",
                    editing && "is-noting",
                    order.drop === "before" && "is-drop-before",
                    order.drop === "after" && "is-drop-after"
                )}
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
                onMouseDown={editing ? undefined : (e) => order.startDrag(e, info.blockid, order.group)}
                onClick={() => {
                    if (!order.takeClick(info.blockid)) {
                        go();
                    }
                }}
                onContextMenu={(e) => showAgentRowMenu(e, subject, order, info.blockid)}
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
                {editing ? (
                    <AgentNoteField at={subject.at} name={name} initial={note} />
                ) : (
                    <>
                        <span className="mt-sb-agent-tx">
                            <AgentNameLine name={name} label={label} />
                            <span className="mt-sb-agent-ss">{doing}</span>
                        </span>
                        {note !== "" ? <AgentNoteTag text={note} /> : null}
                        {look === "working" ? <WorkingDominoes label={agentStateLabel("working")} /> : null}
                    </>
                )}
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
    const workspaceId = agents[0]?.workspaceid ?? "";
    const saved = useAtomValue(AgentOrderModel.getInstance().orderAtom(workspaceId));
    const arrival = useRef<string[]>([]);
    arrival.current = arrivalOrder(arrival.current, agents);
    const ordered = orderAgents(agents, saved, arrival.current);
    const groups = agentGroups(ordered, projects, (info) =>
        projectIdOfAgent(ws ?? {}, projects, info, folders[info.blockid] ?? "")
    );
    const shown =
        groups == null ? ordered.map((a) => a.blockid) : groups.flatMap((g) => g.agents.map((a) => a.blockid));
    const { drag, startDrag, takeClick } = useAgentDrag(workspaceId, shown);
    if (agents.length === 0) {
        return null;
    }
    const rowOrder = (id: string, group: string[]): AgentRowOrder => ({
        shown,
        group,
        drop: drag?.target === id ? (drag.after ? "after" : "before") : null,
        dragged: drag?.id === id,
        startDrag,
        takeClick,
    });
    const flatGroup = ordered.map((a) => a.blockid);
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
                    {ordered.map((a) => (
                        <AgentBlock
                            key={a.blockid}
                            info={a}
                            active={a.tabid === activeTabId}
                            projects={projects}
                            grouped={false}
                            order={rowOrder(a.blockid, flatGroup)}
                        />
                    ))}
                </div>
            ) : (
                groups.map((g) => {
                    const group = g.agents.map((a) => a.blockid);
                    return (
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
                                    order={rowOrder(a.blockid, group)}
                                />
                            ))}
                        </div>
                    );
                })
            )}
        </div>
    );
}
