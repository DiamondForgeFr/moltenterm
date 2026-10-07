// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The agent companion's view (FR-SHELL-018): next to a terminal running Claude Code or Codex, its session as wavesrv
// reads it from the agent's own transcript. Display only: nothing is sent to the agent.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { CopyButton } from "@/app/element/copybutton";
import { Markdown } from "@/app/element/markdown";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget, useAtomValueSafe } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { memo, useEffect, useMemo, useState } from "react";
import { useBlockAgentState } from "../agent-state-ui";
import { PlanUsageSection } from "./companion-gauges";
import {
    CompanionAnswer,
    CompanionAnswerCommand,
    CompanionCandidate,
    CompanionCloseCommand,
    CompanionDiff,
    CompanionDiffCommand,
    CompanionEvent,
    CompanionFile,
    companionMarkdown,
    CompanionOpenCommand,
    CompanionPickCommand,
    CompanionRoute,
    CompanionSessionsCommand,
    CompanionTargetMetaKey,
    CompanionTodo,
    CompanionToolCall,
    CompanionView,
    diffLineKind,
    displayPath,
    firstChangedLine,
    formatArgs,
    integrationProblem,
    MoltentermCompanionView,
    needsLatest,
    neighbourAnswer,
    newerView,
    permissionRequest,
    statusMessage,
    todoCounts,
} from "./companion-model";
import { openChangedFile } from "./companion-open";
import { CompanionSessions } from "./companion-session-store";
import { GuessNotice, SessionBar, SessionHistoryList } from "./companion-session-ui";
import { WorkspaceTaskSection } from "./companion-task";
import { UsageButton } from "./companion-usage";

export { MoltentermCompanionView };

const RpcTimeoutMs = 5000;
// The lease wavesrv keeps a follower for is 45 s.
const LeaseRenewMs = 15000;

function companionCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: CompanionRoute, timeout: RpcTimeoutMs });
}

export class CompanionViewModel implements ViewModel {
    viewType = MoltentermCompanionView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("book-open");
    viewName = atom("Companion");
    noPadding = atom(true);
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
        const open = () =>
            fireAndForget(async () => {
                try {
                    accept(
                        await companionCall<CompanionView>(CompanionOpenCommand, { blockid: target, viewid: viewId })
                    );
                    if (!cancelled) {
                        setError(null);
                    }
                } catch (e) {
                    if (!cancelled) {
                        setError(String(e?.message ?? e));
                    }
                }
            });
        open();
        const timer = setInterval(open, LeaseRenewMs);
        return () => {
            cancelled = true;
            clearInterval(timer);
            unsubscribe();
            fireAndForget(async () => {
                try {
                    await companionCall(CompanionCloseCommand, { blockid: target, viewid: viewId });
                } catch {
                    // wavesrv drops the follower when its lease ends anyway.
                }
            });
        };
    }, [target, viewId]);
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

function CompanionPanel({ model }: ViewComponentProps<CompanionViewModel>) {
    const target = useAtomValue(model.targetAtom);
    const agentState = useBlockAgentState(target);
    const terminal = useAtomValueSafe(target ? getWaveObjectAtom<Block>(makeORef("block", target)) : null);
    const { view, error, viewId, setView } = useCompanion(target);
    const [history, setHistory] = useState(false);
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
    }, [target, view?.agent]);
    if (!target) {
        return <Centered title="No terminal" detail="This companion is not attached to a terminal." />;
    }
    if (error && view == null) {
        return <Centered title="The companion is not available" detail={error} />;
    }
    if (history) {
        return (
            <SessionHistory
                target={target}
                viewId={viewId}
                onPicked={(v) => {
                    setView(v);
                    setHistory(false);
                }}
                onClose={() => setHistory(false)}
            />
        );
    }
    const message = statusMessage(view);
    if (message != null) {
        return (
            <Centered title={message.title} detail={message.detail}>
                <IntegrationNotice view={view} />
                <UsageButton view={view} />
                {view?.status === "searching" ? (
                    <button
                        type="button"
                        onClick={() => setHistory(true)}
                        className="cursor-pointer rounded border border-border px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary"
                        data-testid="companion-history-open"
                    >
                        <i className="fa fa-solid fa-clock-rotate-left mr-1.5" />
                        Choose from the folder's sessions
                    </button>
                ) : null}
            </Centered>
        );
    }
    return (
        <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto" data-testid="companion">
            <SessionBar view={view} onHistory={() => setHistory(true)} />
            <GuessNotice session={session} onHistory={() => setHistory(true)} />
            <IntegrationNotice view={view} className="mx-3 mt-2" />
            {view.usage != null && view.agent ? <PlanUsageSection target={target} agent={view.agent} /> : null}
            <PermissionCard pending={view.pending} agentState={agentState?.state} />
            <AnswerSection key={view.session?.path} target={target} view={view} />
            <TodoSection todos={view.todos} />
            <FilesSection
                key={`files:${view.session?.path}`}
                target={target}
                companionId={model.blockId}
                files={view.files}
                folder={folder}
            />
            <WorkspaceTaskSection target={target} companionId={model.blockId} />
        </div>
    );
}

function Centered({ title, detail, children }: { title: string; detail?: string; children?: React.ReactNode }) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
            <div className="text-sm font-medium text-primary">{title}</div>
            {detail ? <div className="max-w-[360px] text-xs text-secondary">{detail}</div> : null}
            {children}
        </div>
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
                    setError(String(e?.message ?? e));
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
                setError(String(e?.message ?? e));
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
            className={cn("max-w-[360px] text-[11px] text-warning", className)}
            data-testid="companion-integration-problem"
        >
            {problem}
        </div>
    );
}

function PermissionCard({ pending, agentState }: { pending: CompanionToolCall[]; agentState: string }) {
    const request = permissionRequest(pending, agentState);
    if (request == null) {
        return null;
    }
    return (
        <div className="m-3 mb-0 rounded border border-warning/60 bg-warning/10 p-2" data-testid="companion-permission">
            <div className="mb-1 text-xs font-medium text-warning">
                Permission request · <span className="font-mono">{request.tool}</span>
            </div>
            {request.args ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-secondary">
                    {formatArgs(request.args)}
                </pre>
            ) : null}
            <div className="mt-1 text-[11px] text-muted">Answer it in the terminal.</div>
        </div>
    );
}

function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
    return (
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
            <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">{children}</div>
            <div className="ml-auto flex items-center gap-1">{right}</div>
        </div>
    );
}

function NavButton({
    label,
    icon,
    disabled,
    onClick,
}: {
    label: string;
    icon: string;
    disabled: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "rounded px-1.5 py-0.5 text-xs text-secondary",
                disabled ? "opacity-40" : "cursor-pointer hover:bg-hover hover:text-primary"
            )}
        >
            <i className={`fa fa-solid fa-${icon}`} />
        </button>
    );
}

// The latest answer follows the session; browsing back pins an earlier one until "Latest".
function AnswerSection({ target, view }: { target: string; view: CompanionView }) {
    const [pinned, setPinned] = useState<number>(null);
    const [earlier, setEarlier] = useState<CompanionAnswer>(null);
    const [error, setError] = useState<string>(null);
    const answers = view.answers ?? [];
    const latest = view.latest;
    useEffect(() => {
        setEarlier(null);
        setError(null);
        if (pinned == null) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const a = await companionCall<CompanionAnswer>(CompanionAnswerCommand, {
                    blockid: target,
                    index: pinned,
                });
                if (!cancelled) {
                    setEarlier(a);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(String(e?.message ?? e));
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [target, pinned]);
    const shown = pinned == null ? latest : earlier;
    const current = shown?.index ?? latest?.index;
    const pos = answers.findIndex((a) => a.index === current);
    const go = (step: -1 | 1) => {
        const next = neighbourAnswer(answers, current, step);
        if (next == null) {
            return;
        }
        setPinned(next === latest?.index ? null : next);
    };
    const markdown = useMemo(() => companionMarkdown(shown?.markdown), [shown?.markdown]);
    if (latest == null) {
        return (
            <>
                <SectionTitle>Answer</SectionTitle>
                <div className="px-3 text-xs text-muted">No answer yet in this session.</div>
            </>
        );
    }
    return (
        <>
            <SectionTitle
                right={
                    <>
                        <NavButton
                            label="Earlier answer"
                            icon="chevron-left"
                            disabled={pos <= 0}
                            onClick={() => go(-1)}
                        />
                        <span className="text-[11px] text-muted tabular-nums" data-testid="companion-answer-pos">
                            {pos + 1} / {answers.length}
                        </span>
                        <NavButton
                            label="Later answer"
                            icon="chevron-right"
                            disabled={pos < 0 || pos >= answers.length - 1}
                            onClick={() => go(1)}
                        />
                        {pinned != null ? (
                            <button
                                type="button"
                                onClick={() => setPinned(null)}
                                className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-hover"
                            >
                                Latest
                            </button>
                        ) : null}
                        <CopyButton
                            title="Copy the answer as markdown"
                            onClick={() => fireAndForget(() => navigator.clipboard.writeText(shown?.markdown ?? ""))}
                        />
                    </>
                }
            >
                {pinned == null ? "Latest answer" : "Earlier answer"}
            </SectionTitle>
            {error ? <div className="px-3 text-xs text-error">{error}</div> : null}
            <div className="px-3" data-testid="companion-answer">
                {shown ? <AnswerMarkdown markdown={markdown} /> : <div className="text-xs text-muted">Loading…</div>}
            </div>
        </>
    );
}

const AnswerMarkdown = memo(({ markdown }: { markdown: string }) => {
    return <Markdown text={markdown} scrollable={false} fontSizeOverride={13} fixedFontSizeOverride={12} />;
});
AnswerMarkdown.displayName = "AnswerMarkdown";

const TodoIcons: Record<string, string> = {
    completed: "fa-solid fa-circle-check text-success",
    in_progress: "fa-solid fa-circle-half-stroke text-accent",
    pending: "fa-regular fa-circle text-muted",
};

function TodoSection({ todos }: { todos: CompanionTodo[] }) {
    if (todos == null || todos.length === 0) {
        return null;
    }
    const { done, total } = todoCounts(todos);
    return (
        <>
            <SectionTitle right={<span className="text-[11px] text-muted tabular-nums">{`${done} / ${total}`}</span>}>
                Tasks
            </SectionTitle>
            <ul className="flex flex-col gap-1 px-3" data-testid="companion-todos">
                {todos.map((t, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                        <i className={cn("mt-0.5 fa-fw", TodoIcons[t.status] ?? TodoIcons.pending)} />
                        <span className={cn(t.status === "completed" ? "text-muted line-through" : "text-primary")}>
                            {t.text}
                        </span>
                    </li>
                ))}
            </ul>
        </>
    );
}

const KindLabels: Record<string, { text: string; className: string; title: string }> = {
    add: { text: "A", className: "text-success", title: "Added" },
    update: { text: "M", className: "text-warning", title: "Modified" },
    delete: { text: "D", className: "text-error", title: "Deleted" },
};

function FilesSection({
    target,
    companionId,
    files,
    folder,
}: {
    target: string;
    companionId: string;
    files: CompanionFile[];
    folder: string;
}) {
    const [open, setOpen] = useState<string>(null);
    if (files == null || files.length === 0) {
        return (
            <>
                <SectionTitle>Files changed</SectionTitle>
                <div className="px-3 pb-3 text-xs text-muted">No file changed in this session yet.</div>
            </>
        );
    }
    return (
        <>
            <SectionTitle right={<span className="text-[11px] text-muted tabular-nums">{files.length}</span>}>
                Files changed
            </SectionTitle>
            <ul className="flex flex-col px-1 pb-3" data-testid="companion-files">
                {files.map((f) => (
                    <FileRow
                        key={f.path}
                        target={target}
                        companionId={companionId}
                        file={f}
                        folder={folder}
                        open={open === f.path}
                        onToggle={() => setOpen(open === f.path ? null : f.path)}
                    />
                ))}
            </ul>
        </>
    );
}

function FileRow({
    target,
    companionId,
    file,
    folder,
    open,
    onToggle,
}: {
    target: string;
    companionId: string;
    file: CompanionFile;
    folder: string;
    open: boolean;
    onToggle: () => void;
}) {
    const kind = KindLabels[file.kind] ?? KindLabels.update;
    // The preview opens at the line the first change of the file starts.
    const openAtChange = () =>
        fireAndForget(async () => {
            let line = 0;
            try {
                const d = await companionCall<CompanionDiff>(CompanionDiffCommand, {
                    blockid: target,
                    path: file.path,
                });
                line = firstChangedLine(d?.diff);
            } catch {
                // Without its diff the file still opens, at its top.
            }
            openChangedFile(file.path, line, companionId);
        });
    return (
        <li className="flex flex-col">
            <div className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-hover">
                <button
                    type="button"
                    onClick={onToggle}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                    title={file.path}
                    aria-expanded={open}
                >
                    <i
                        className={cn(
                            "fa fa-solid fa-fw text-[10px] text-muted",
                            open ? "fa-chevron-down" : "fa-chevron-right"
                        )}
                    />
                    <span
                        className={cn("w-3 shrink-0 font-mono text-[11px] font-semibold", kind.className)}
                        title={kind.title}
                    >
                        {kind.text}
                    </span>
                    <span className="truncate font-mono text-xs text-primary">{displayPath(file.path, folder)}</span>
                </button>
                <span className="shrink-0 font-mono text-[11px] tabular-nums">
                    <span className="text-success">+{file.added}</span>{" "}
                    <span className="text-error">−{file.removed}</span>
                </span>
                {file.kind !== "delete" ? (
                    <button
                        type="button"
                        onClick={openAtChange}
                        className="cursor-pointer rounded px-1 text-[11px] text-secondary hover:text-primary"
                        title="Open in the preview"
                        aria-label={`Open ${file.path} in the preview`}
                    >
                        <i className="fa fa-solid fa-arrow-up-right-from-square" />
                    </button>
                ) : null}
            </div>
            {open ? <FileDiffView target={target} path={file.path} edits={file.edits} /> : null}
        </li>
    );
}

// The diff is fetched when opened, and again when the agent edits the file once more.
function FileDiffView({ target, path, edits }: { target: string; path: string; edits: number }) {
    const [diff, setDiff] = useState<CompanionDiff>(null);
    const [error, setError] = useState<string>(null);
    useEffect(() => {
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const d = await companionCall<CompanionDiff>(CompanionDiffCommand, { blockid: target, path });
                if (!cancelled) {
                    setDiff(d);
                    setError(null);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(String(e?.message ?? e));
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [target, path, edits]);
    if (error) {
        return <div className="px-3 text-xs text-error">{error}</div>;
    }
    if (diff == null) {
        return <div className="px-3 text-xs text-muted">Loading…</div>;
    }
    const lines = diff.diff ? diff.diff.replace(/\n$/, "").split("\n") : [];
    return (
        <div
            className="mx-2 mb-2 overflow-x-auto rounded border border-border bg-black/20"
            data-testid="companion-diff"
        >
            {diff.truncated ? (
                <div className="px-2 py-1 text-[11px] text-muted">Earlier edits are not kept.</div>
            ) : null}
            {lines.length === 0 ? <div className="px-2 py-1 text-[11px] text-muted">No diff recorded.</div> : null}
            <pre className="m-0 py-1 font-mono text-[11px] leading-[1.45]">
                {lines.map((line, i) => (
                    <div key={i} className={cn("px-2 whitespace-pre", DiffLineClasses[diffLineKind(line)])}>
                        {line || " "}
                    </div>
                ))}
            </pre>
        </div>
    );
}

const DiffLineClasses: Record<string, string> = {
    add: "bg-success/10 text-success",
    del: "bg-error/10 text-error",
    hunk: "text-accent/80",
    meta: "text-muted",
    ctx: "text-secondary",
};
