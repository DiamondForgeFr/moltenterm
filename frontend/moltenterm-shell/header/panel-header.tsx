// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The panel header's lead and pill for every panel (FR-SHELL-052, DS-SHELL-093), drawn by Wave's blockframe-header:
// [16 px icon] Title (12/600), the muted context (a terminal's project and branch, once; the connection only when
// remote), then at most one Pill before the end buttons. A waiting agent's pill shows its question with Go; a
// working agent draws a segment along the header's bottom edge. The terminal's proposals (hooks, update, worktree
// link) are the command panel's suggestions (header-proposals.ts); the header only hosts their dialogs.

import { atoms, getConnStatusAtom, globalStore, refocusNode } from "@/app/store/global";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { cn, isLocalConnName, makeIconClass, NullAtom, useAtomValueSafe } from "@/util/util";
import { Atom, PrimitiveAtom, useAtomValue } from "jotai";
import type { ReactElement, RefObject } from "react";
import { useEffect } from "react";
import { AgentHookOfferHost } from "../agent-hooks-ui";
import { agentStateTitle } from "../agent-state-model";
import { useBlockAgentState } from "../agent-state-ui";
import { openCommandPanel } from "../command-panel/command-panel-store";
import { sessionTooltipLine } from "../companion/companion-model";
import { toggleCompanion } from "../companion/companion-open";
import { CompanionSessions } from "../companion/companion-session-store";
import { usePaneStatus } from "../pane-status";
import { formatShortcutById } from "../shortcuts/format";
import { blockFolder, makePaneView } from "../status-bar-model";
import { TermUpdateHost } from "../termupdate/termupdate-ui";
import { readWorktreeDismissed, readWorktreeLink, TreeMarker, treeMarker, worktreeOffer } from "../worktree-model";
import { unlinkWorktree } from "../worktree-store";
import {
    agentErrorPill,
    durablePill,
    HeaderContextPart,
    HeaderPillSpec,
    missingWorktreePill,
    multiInputPill,
    pickHeaderPill,
    remotePill,
    termContextParts,
    termHeaderTitle,
    waitingPill,
} from "./header-model";
import { HeaderProposals } from "./header-proposals";
import "./header.css";
import { Pill } from "./pill";

const NullStatusAtom = NullAtom as Atom<ConnStatus>;
const NullBlockAtom = NullAtom as Atom<Block>;

type TermViewModelLike = ViewModel & {
    tabModel?: { isTermMultiInput?: PrimitiveAtom<boolean> };
    termDurableStatus?: Atom<BlockJobStatusData>;
    termConfigedDurable?: Atom<boolean>;
};

export type MoltenHeaderInput = {
    blockId: string;
    viewModel: ViewModel;
    preview: boolean;
    // A terminal with MoltenTerm's terminal header (Wave's useTermHeader: not a command, not a Wave app).
    termHeader: boolean;
    manageConnection: boolean;
    connection: string;
    frameTitle: string;
    viewName: string;
    localHostName: string;
    changeConnModalAtom: PrimitiveAtom<boolean>;
};

export type MoltenHeaderState = {
    blockId: string;
    title: string;
    titleHint: string;
    agentTitle: boolean;
    local: boolean;
    remoteConnection: string;
    remoteTitle: string;
    context: HeaderContextPart[];
    pill: HeaderPillSpec;
    working: boolean;
    termHeader: boolean;
    preview: boolean;
    openConnection: () => void;
};

function companionShortcutLabel(): string {
    return formatShortcutById("companion");
}

// The terminal's tree, project and branch from the status bar's probe (DS-SHELL-010), one call shared with the bar.
function useTermTree(blockId: string) {
    const block = useAtomValue(blockId ? getWaveObjectAtom<Block>(makeORef("block", blockId)) : NullBlockAtom);
    const ws = useAtomValue(atoms.workspace);
    const meta = blockId ? block?.meta : null;
    const folder = blockFolder({ view: meta?.view, connection: meta?.connection, "cmd:cwd": meta?.["cmd:cwd"] });
    const link = readWorktreeLink(meta);
    const local = meta?.view === "term" && isLocalConnName(meta?.connection);
    const probeDir = folder || (local && link.startsWith("/") ? link : "");
    const state = usePaneStatus(probeDir, folder ? blockId : null, link);
    const marker: TreeMarker = probeDir ? treeMarker(state, link) : null;
    const pane = probeDir ? makePaneView(probeDir, state, ws) : null;
    const offer = local && probeDir ? worktreeOffer(state, link, readWorktreeDismissed(meta)) : "";
    useEffect(() => {
        if (!blockId) {
            return;
        }
        HeaderProposals.getInstance().setWorktreeOffer(blockId, offer);
    }, [blockId, offer]);
    return { folder: probeDir, pane, marker };
}

// Called once by the header; both the lead and the pill draw from it.
export function useMoltenHeader(input: MoltenHeaderInput): MoltenHeaderState {
    const { blockId, viewModel, preview, termHeader, manageConnection, connection } = input;
    const termModel = viewModel as TermViewModelLike;
    const agent = useBlockAgentState(termHeader && !preview ? blockId : null);
    const tree = useTermTree(termHeader && !preview ? blockId : null);
    const companionSession = useAtomValue(CompanionSessions.getInstance().sessionAtom(blockId ?? ""));
    const local = isLocalConnName(connection);
    const connStatus = useAtomValue(manageConnection && !local ? getConnStatusAtom(connection) : NullStatusAtom);
    const multiInput = useAtomValueSafe(termHeader ? termModel?.tabModel?.isTermMultiInput : null);
    const durableConfigured = useAtomValueSafe(termHeader ? termModel?.termConfigedDurable : null);
    const durableStatus = useAtomValueSafe(termHeader ? termModel?.termDurableStatus : null);

    const title = termHeader ? termHeaderTitle(agent, input.frameTitle, "") : input.frameTitle || input.viewName;
    const titleHint =
        agent != null
            ? [
                  agentStateTitle(agent),
                  sessionTooltipLine(companionSession, Date.now()),
                  tree.folder,
                  local && input.localHostName ? `on ${input.localHostName}` : "",
                  `Click for the agent companion (${companionShortcutLabel()})`,
              ]
                  .filter((s) => !!s)
                  .join("\n")
            : "";
    const context =
        termHeader && tree.pane != null
            ? termContextParts({
                  folder: tree.folder,
                  projectName: tree.pane.projectName,
                  projectTitle: tree.pane.projectTitle,
                  branch: tree.pane.branch,
                  branchTitle: tree.pane.branchTitle,
                  marker: tree.marker,
              })
            : [];
    const pill = pickHeaderPill([
        waitingPill(agent),
        agentErrorPill(agent),
        missingWorktreePill(tree.marker),
        multiInputPill(termHeader && !!multiInput),
        manageConnection ? remotePill(connection, local, connStatus) : null,
        termHeader ? durablePill(durableConfigured, durableStatus?.status) : null,
    ]);
    const openConnection = () => {
        if (!manageConnection) {
            return;
        }
        globalStore.set(input.changeConnModalAtom, true);
    };
    return {
        blockId,
        title,
        titleHint,
        agentTitle: agent != null,
        local,
        remoteConnection: manageConnection && !local ? connection : "",
        remoteTitle:
            manageConnection && !local ? (pill?.kind === "remote" ? pill.title : `Connected to ${connection}`) : "",
        context,
        pill,
        working: agent?.state === "working",
        termHeader,
        preview,
        openConnection,
    };
}

type LeadProps = {
    state: MoltenHeaderState;
    iconElem: ReactElement;
    iconName: string;
    iconColor: string;
    manageConnection: boolean;
    localHostName: string;
    connBtnRef: RefObject<HTMLDivElement>;
    preIcon: ReactElement;
};

function ContextPart({ part }: { part: HeaderContextPart }) {
    return (
        <span className="molten-header-context-part" title={part.title}>
            {part.icon ? (
                <i className={cn(makeIconClass(part.icon, false), "text-11", part.iconClass)} aria-hidden />
            ) : null}
            <span className="truncate">{part.text}</span>
        </span>
    );
}

// The icon, the title and the context. A local panel that can switch connection keeps its switch on the icon: the
// host name is in its tooltip, never a label (FR-SHELL-052-AC2).
export function MoltenHeaderLead({
    state,
    iconElem,
    iconName,
    iconColor,
    manageConnection,
    localHostName,
    connBtnRef,
    preIcon,
}: LeadProps) {
    const localSwitch = manageConnection && state.local && !state.preview && iconName != null;
    const icon = localSwitch ? (
        <div
            ref={connBtnRef}
            role="button"
            tabIndex={0}
            className="block-frame-view-icon molten-header-icon-switch cursor-pointer rounded-4 hover:bg-hover"
            title={`Connected to Local Machine${localHostName ? ` (${localHostName})` : ""}\nClick to switch connection`}
            aria-label="Switch connection"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
                e.stopPropagation();
                state.openConnection();
            }}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    state.openConnection();
                }
            }}
        >
            <i
                className={cn("block-frame-icon", makeIconClass(iconName, true))}
                style={iconColor ? { color: iconColor } : undefined}
            />
        </div>
    ) : (
        iconElem
    );
    const blockId = state.blockId;
    return (
        <>
            {/* In a narrow panel the context gives way first, then the pill: the title keeps its room. */}
            <div className="block-frame-default-header-iconview !max-w-[45%] !shrink-0 !overflow-hidden">
                {icon}
                {!state.title ? null : state.agentTitle && !state.preview ? (
                    <button
                        type="button"
                        className="block-frame-view-type molten-header-title px-1"
                        title={state.titleHint}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleCompanion(blockId);
                        }}
                        data-testid="agent-header-label"
                    >
                        {state.title}
                    </button>
                ) : (
                    <div className="block-frame-view-type molten-header-title">{state.title}</div>
                )}
            </div>
            {preIcon}
            {state.context.length > 0 || state.remoteConnection ? (
                <div className="molten-header-context" data-role="molten-header-context">
                    {state.remoteConnection ? (
                        <div
                            ref={connBtnRef}
                            role="button"
                            tabIndex={0}
                            className="molten-header-context-part molten-header-link cursor-pointer px-1"
                            title={`${state.remoteTitle}\nClick to switch connection`}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                                e.stopPropagation();
                                state.openConnection();
                            }}
                            data-testid="molten-header-connection"
                        >
                            <span className="truncate">{state.remoteConnection}</span>
                        </div>
                    ) : null}
                    {state.context.map((part) => (
                        <ContextPart key={part.key} part={part} />
                    ))}
                </div>
            ) : null}
            {state.termHeader && !state.preview ? (
                <>
                    <AgentHookOfferHost blockId={blockId} />
                    <TermUpdateHost blockId={blockId} />
                </>
            ) : null}
        </>
    );
}

function stopMultiInput(viewModel: ViewModel) {
    const flag = (viewModel as TermViewModelLike)?.tabModel?.isTermMultiInput;
    if (flag != null) {
        globalStore.set(flag, false);
    }
}

// The one pill, at the end of the context (before the end buttons), so it never moves the title or the context.
export function MoltenHeaderPill({ state, viewModel }: { state: MoltenHeaderState; viewModel: ViewModel }) {
    const pill = state.pill;
    if (pill == null || state.preview) {
        return null;
    }
    const blockId = state.blockId;
    let onClick: () => void = null;
    let onAction: () => void = null;
    let actionLabel: string = null;
    switch (pill.kind) {
        case "waiting":
            onAction = () => refocusNode(blockId);
            actionLabel = "Go to the terminal";
            break;
        case "missingworktree":
            onAction = () => unlinkWorktree(blockId);
            actionLabel = "Unlink this terminal from the missing worktree";
            break;
        case "multiinput":
            onClick = () => stopMultiInput(viewModel);
            break;
        case "remote":
            onClick = state.openConnection;
            break;
        case "durable":
            onClick = () => openCommandPanel(blockId, "menu", "Durable session");
            break;
    }
    return (
        <div className="molten-header-pill" data-role="molten-header-pill">
            <Pill
                label={pill.label}
                tone={pill.tone}
                title={pill.title}
                dot={pill.dot}
                icon={pill.icon}
                action={pill.action}
                actionLabel={actionLabel}
                onAction={onAction}
                onClick={onClick}
                testId={`molten-pill-${pill.kind}`}
            />
        </div>
    );
}

export function MoltenHeaderWorking({ state }: { state: MoltenHeaderState }) {
    if (!state.working || state.preview) {
        return null;
    }
    return <span className="molten-header-working" aria-hidden data-role="molten-header-working" />;
}

// A dot on the command panel's trigger while the terminal has a proposal there.
export function useHeaderHasProposal(blockId: string, termHeader: boolean): boolean {
    return useAtomValue(
        termHeader && blockId ? HeaderProposals.getInstance().hasProposalAtom(blockId) : (NullAtom as Atom<boolean>)
    );
}

// A view's own pills (Wave's header elements of type "pill") give way to the header's most urgent state.
export function withoutHeaderPills(elems: HeaderElem[]): HeaderElem[] {
    return (elems ?? [])
        .filter((e) => e?.elemtype !== "pill")
        .map((e) => (e?.elemtype === "div" ? { ...e, children: withoutHeaderPills(e.children) } : e));
}
