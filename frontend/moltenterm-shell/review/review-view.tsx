// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab (FR-REV-002, DS-REV-012): a PR's changed files as a tree with their status, counts and viewed marks;
// the selected file's diff in Wave's Monaco diff editor, side by side or unified; and the button of the AI panel, a pane
// of its own (review-ai-view.tsx) where the review session's cards show above the agent's own terminal. The diff is
// read-only text: nothing from it is executed.

import { openLink, useOverrideConfigAtom } from "@/app/store/global";
import { boundNumber, cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../empty-state";
import { MonacoDiffViewer } from "../lazy/monaco-lazy";
import { MoltenWave } from "../molten-button";
import { CommentsStrip, SelectionOverlay } from "./review-actions-view";
import { ReviewFile, ReviewState } from "./review-client";
import {
    collapsedReason,
    collapsedTag,
    formatBytes,
    isViewed,
    languageOf,
    MoltentermReviewView,
    newCommitsLabel,
    nextFile,
    shortOid,
    sideBySideOf,
    StatusLetters,
    TreeNode,
} from "./review-model";
import { commentCounts } from "./review-selection";
import { ReviewFileView, ReviewTabModel } from "./review-tab-model";
import { ValidateButton, ValidateSheet } from "./review-validate";

export { MoltentermReviewView };

const ToolbarButton =
    "flex h-6 cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 text-12 whitespace-nowrap text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

export class ReviewViewModel extends ReviewTabModel {
    get viewComponent(): ViewComponent {
        return ReviewView;
    }
}

export function ReviewView({ model }: ViewComponentProps<ReviewViewModel>) {
    const pr = useAtomValue(model.prAtom);
    useEffect(() => {
        if (pr == null) {
            return;
        }
        return model.start();
    }, [model, pr == null]);
    if (pr == null) {
        return (
            <EmptyState
                icon="code-pull-request"
                title="No pull request in this review"
                hint="Open a pull request's review from the Reviews view."
            />
        );
    }
    return (
        <div className="flex h-full min-h-0 w-full flex-col" data-role="molten-review">
            <ReviewHeader model={model} />
            <div className="flex min-h-0 flex-1">
                <FilesPanel model={model} />
                <DiffPanel model={model} />
            </div>
            <ValidateSheet model={model} />
        </div>
    );
}

function ReviewHeader({ model }: { model: ReviewViewModel }) {
    const pr = useAtomValue(model.prAtom);
    const head = useAtomValue(model.headAtom);
    const files = useAtomValue(model.filesAtom);
    const loading = useAtomValue(model.filesLoadingAtom);
    const newCommits = useAtomValue(model.newCommitsAtom);
    const mode = useAtomValue(model.modeAtom);
    const state = useAtomValue(model.stateAtom);
    const viewed = useAtomValue(model.viewedCountAtom);
    const sideBySideToggle = useAtomValue(model.sideBySideAtom);
    const inlineDiff = useOverrideConfigAtom(model.blockId, "editor:inlinediff");
    const aiPaneId = useAtomValue(model.aiPaneIdAtom);
    const aiOpen = aiPaneId != null;
    const sideBySide = sideBySideOf(sideBySideToggle, inlineDiff);
    const since = state?.since;
    const hasSince = since != null && since.to === head && since.from !== head;
    const total = files?.files.length ?? 0;
    return (
        <div className="flex flex-col gap-1.5 border-b border-border px-3 py-2">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-13 leading-5 font-medium" title={pr.title}>
                        {pr.ticket ? <span className="mr-1.5 text-accent">#{pr.ticket}</span> : null}
                        {pr.title || `Pull request #${pr.number}`}
                    </div>
                    <div className="truncate text-12 text-muted">
                        PR #{pr.number} · <code>{pr.headref}</code> into <code>{pr.baseref}</code>
                        {head ? (
                            <>
                                {" "}
                                · head <code title={head}>{shortOid(head)}</code>
                            </>
                        ) : null}
                        {mode === "since" && since ? (
                            <>
                                {" "}
                                · since <code title={since.from}>{shortOid(since.from)}</code>
                            </>
                        ) : null}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {newCommits != null ? (
                        <button
                            type="button"
                            className="molten-btn flex h-6 cursor-pointer items-center gap-1.5 rounded-6 px-2 text-12"
                            onClick={() => fireAndForget(() => model.refresh())}
                            title="The pull request moved: show its new head"
                            data-testid="review-new-commits"
                        >
                            <i className="fa fa-solid fa-rotate text-11" />
                            {newCommitsLabel(newCommits.commits, newCommits.rewritten)} · Refresh
                            <MoltenWave />
                        </button>
                    ) : null}
                    {pr.url ? (
                        <button
                            type="button"
                            className={ToolbarButton}
                            onClick={() => fireAndForget(() => openLink(pr.url))}
                            title="Open the pull request on GitHub"
                        >
                            <i className="fa fa-solid fa-arrow-up-right-from-square text-11" />
                            GitHub
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className={cn(ToolbarButton, aiOpen && "border-accent/60 text-primary")}
                        onClick={() => fireAndForget(() => model.toggleAi())}
                        aria-pressed={aiOpen}
                        title={
                            aiOpen
                                ? "Close the AI panel (the review session keeps running)"
                                : "Open the AI panel: the PR's briefing, and the review session"
                        }
                        data-testid="review-ai-toggle"
                    >
                        <i className="fa fa-solid fa-sparkles text-11" />
                        AI panel
                    </button>
                    <PublishButton model={model} />
                    <ValidateButton model={model} />
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-12">
                <Segmented
                    label="Diff"
                    value={mode}
                    options={[
                        { value: "full", label: "All changes", title: "The PR's changes against its base (as GitHub)" },
                        {
                            value: "since",
                            label: since?.published ? "Since last round" : "Since last viewed",
                            title: since?.published
                                ? "The changes since the head of the last published review round"
                                : "The changes since the head you read before",
                            disabled: !hasSince,
                        },
                    ]}
                    onChange={(v) => fireAndForget(() => model.setMode(v as "full" | "since"))}
                    testId="review-mode"
                />
                <Segmented
                    label="Layout"
                    value={sideBySide ? "split" : "unified"}
                    options={[
                        { value: "split", label: "Side by side" },
                        { value: "unified", label: "Unified" },
                    ]}
                    onChange={(v) => model.setSideBySide(v === "split")}
                    testId="review-layout"
                />
                <span className="ml-auto text-muted" data-testid="review-viewed-count">
                    {loading ? "Reading the changes…" : `${viewed} / ${total} viewed`}
                </span>
            </div>
        </div>
    );
}

// PublishButton carries the count of staged comments (FR-REV-009 AC4). Publishing them as one GitHub review is
// FR-REV-010's; until then it shows them in the AI panel.
function PublishButton({ model }: { model: ReviewViewModel }) {
    const staged = useAtomValue(model.stagedCountAtom);
    return (
        <button
            type="button"
            className={ToolbarButton}
            disabled={staged === 0}
            onClick={() => fireAndForget(() => model.openPublish())}
            title={
                staged === 0
                    ? "No comment is staged: stage drafts or accept proposals first"
                    : "Show the staged comments in the AI panel (publishing on GitHub is not available yet)"
            }
            data-testid="review-publish"
            data-count={staged}
        >
            <i className="fa fa-solid fa-paper-plane text-11" />
            Publish review ({staged})
        </button>
    );
}

type SegmentOption = { value: string; label: string; title?: string; disabled?: boolean };

function Segmented({
    label,
    value,
    options,
    onChange,
    testId,
}: {
    label: string;
    value: string;
    options: SegmentOption[];
    onChange: (value: string) => void;
    testId?: string;
}) {
    return (
        <div
            className="flex overflow-hidden rounded-6 border border-border"
            role="group"
            aria-label={label}
            data-testid={testId}
        >
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    disabled={o.disabled}
                    aria-pressed={value === o.value}
                    title={o.title}
                    onClick={() => onChange(o.value)}
                    className={cn(
                        "h-6 cursor-pointer border-r border-border px-2 text-12 last:border-r-0 disabled:cursor-default disabled:opacity-40",
                        value === o.value ? "bg-hover text-primary" : "text-secondary hover:text-primary"
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function FilesPanel({ model }: { model: ReviewViewModel }) {
    const tree = useAtomValue(model.treeAtom);
    const files = useAtomValue(model.orderedFilesAtom);
    const result = useAtomValue(model.filesAtom);
    const error = useAtomValue(model.filesErrorAtom);
    const loading = useAtomValue(model.filesLoadingAtom);
    const selected = useAtomValue(model.selectedAtom);
    const state = useAtomValue(model.stateAtom);
    const listRef = useRef<HTMLDivElement>(null);
    const counts = useMemo(() => commentCounts(state), [state]);
    useEffect(() => {
        if (selected == null) {
            return;
        }
        listRef.current
            ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`)
            ?.scrollIntoView?.({ block: "nearest" });
    }, [selected]);
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
            return;
        }
        e.preventDefault();
        const next = nextFile(files, selected, e.key === "ArrowDown" ? 1 : -1);
        if (next != null) {
            model.selectFile(next.path);
            listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next.path)}"]`)?.focus();
        }
    };
    return (
        <div
            ref={listRef}
            className="flex w-[280px] min-w-[200px] shrink-0 flex-col overflow-auto border-r border-border py-1"
            onKeyDown={onKeyDown}
            role="tree"
            aria-label="Changed files"
            data-testid="review-files"
        >
            {error ? (
                <div
                    className="m-2 rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-12 text-error"
                    title={error}
                >
                    The changes could not be read. {error}
                </div>
            ) : null}
            {result == null && loading ? (
                <div className="px-3 py-2 text-12 text-muted">Reading the changes…</div>
            ) : null}
            {result != null && result.files.length === 0 ? (
                <div className="px-3 py-2 text-12 text-muted">No file changed.</div>
            ) : null}
            <TreeLevel model={model} nodes={tree} depth={0} selected={selected} state={state} counts={counts} />
        </div>
    );
}

function TreeLevel({
    model,
    nodes,
    depth,
    selected,
    state,
    counts,
}: {
    model: ReviewViewModel;
    nodes: TreeNode[];
    depth: number;
    selected: string;
    state: ReviewState;
    counts: Map<string, number>;
}) {
    return (
        <>
            {nodes.map((node) =>
                node.file != null ? (
                    <FileRow
                        key={node.path}
                        model={model}
                        node={node}
                        depth={depth}
                        selected={selected === node.path}
                        viewed={isViewed(state, node.file)}
                        comments={counts.get(node.file.path) ?? 0}
                    />
                ) : (
                    <FolderRow
                        key={node.path}
                        model={model}
                        node={node}
                        depth={depth}
                        selected={selected}
                        state={state}
                        counts={counts}
                    />
                )
            )}
        </>
    );
}

function FolderRow({
    model,
    node,
    depth,
    selected,
    state,
    counts,
}: {
    model: ReviewViewModel;
    node: TreeNode;
    depth: number;
    selected: string;
    state: ReviewState;
    counts: Map<string, number>;
}) {
    const [open, setOpen] = useState(true);
    return (
        <div role="treeitem" aria-expanded={open}>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex w-full cursor-pointer items-center gap-1.5 py-0.5 pr-2 text-left text-12 text-secondary hover:bg-hover"
                style={{ paddingLeft: 8 + depth * 12 }}
                title={node.path}
            >
                <i
                    className={cn(
                        "fa fa-solid fa-chevron-right w-2.5 text-10 transition-transform duration-120 ease-mt",
                        open && "rotate-90"
                    )}
                />
                <i className="fa fa-solid fa-folder text-11 text-muted" />
                <span className="truncate">{node.name}</span>
            </button>
            {open ? (
                <div role="group">
                    <TreeLevel
                        model={model}
                        nodes={node.children}
                        depth={depth + 1}
                        selected={selected}
                        state={state}
                        counts={counts}
                    />
                </div>
            ) : null}
        </div>
    );
}

const FileRow = memo(function FileRow({
    model,
    node,
    depth,
    selected,
    viewed,
    comments,
}: {
    model: ReviewViewModel;
    node: TreeNode;
    depth: number;
    selected: boolean;
    viewed: boolean;
    comments: number;
}) {
    const file = node.file;
    const status = StatusLetters[file.status] ?? StatusLetters.modified;
    const tag = collapsedTag(file.collapsed);
    const title = [
        file.path,
        file.oldpath ? `renamed from ${file.oldpath}` : null,
        `${status.label}, +${file.additions} −${file.deletions}`,
        tag ? collapsedReason(file.collapsed, file) : null,
    ]
        .filter(Boolean)
        .join("\n");
    return (
        <div
            role="treeitem"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-path={file.path}
            onClick={() => model.selectFile(file.path)}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    model.selectFile(file.path);
                }
            }}
            className={cn(
                "group flex cursor-pointer items-center gap-1.5 py-0.5 pr-2 text-12 outline-none hover:bg-hover focus-visible:bg-hover",
                selected && "bg-hover text-primary",
                viewed && !selected && "text-muted"
            )}
            style={{ paddingLeft: 20 + depth * 12 }}
            title={title}
            data-testid="review-file"
        >
            <span
                className={cn("w-3 shrink-0 text-center font-mono text-11 font-semibold", status.tone)}
                aria-label={status.label}
            >
                {status.letter}
            </span>
            <span className={cn("min-w-0 flex-1 truncate", viewed && "line-through decoration-muted/60")}>
                {node.name}
                {file.oldpath ? (
                    <span className="ml-1 text-11 text-muted">← {file.oldpath.split("/").pop()}</span>
                ) : null}
            </span>
            {tag ? (
                <span className="shrink-0 rounded-4 border border-border px-1 text-10 text-muted">{tag}</span>
            ) : null}
            {comments > 0 ? (
                <span
                    className="flex shrink-0 items-center gap-0.5 text-10 text-muted"
                    title={comments === 1 ? "1 comment" : `${comments} comments`}
                    data-testid="review-file-comments"
                >
                    <i className="fa fa-solid fa-comment text-10" />
                    {comments}
                </span>
            ) : null}
            <span className="shrink-0 font-mono text-11">
                <span className="text-success">+{file.additions}</span>{" "}
                <span className="text-error">−{file.deletions}</span>
            </span>
            <input
                type="checkbox"
                className="shrink-0 cursor-pointer accent-[var(--accent-color)]"
                checked={viewed}
                onClick={(e) => e.stopPropagation()}
                onChange={() => model.toggleViewed(file)}
                aria-label={`Viewed: ${file.path}`}
                title={viewed ? "Viewed (uncheck to read it again)" : "Mark as viewed"}
                data-testid="review-viewed"
            />
        </div>
    );
});
FileRow.displayName = "FileRow";

function DiffPanel({ model }: { model: ReviewViewModel }) {
    const view = useAtomValue(model.fileAtom);
    const selected = useAtomValue(model.selectedAtom);
    const files = useAtomValue(model.filesAtom);
    const mode = useAtomValue(model.modeAtom);
    const renderMs = useAtomValue(model.renderMsAtom);
    const file = (files?.files ?? []).find((f) => f.path === selected) ?? null;
    if (file == null || view == null || view.path !== file.path) {
        return (
            <div
                className="flex min-w-0 flex-1 items-center justify-center text-12 text-muted"
                data-testid="review-diff-empty"
            >
                {files == null ? "" : "Select a file to see its changes."}
            </div>
        );
    }
    return (
        <div className="flex min-w-0 flex-1 flex-col" data-testid="review-diff">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-12">
                <span className="min-w-0 truncate font-mono" title={file.path}>
                    {file.oldpath ? (
                        <>
                            <span className="text-muted">{file.oldpath}</span> →{" "}
                        </>
                    ) : null}
                    {file.path}
                </span>
                <span className="shrink-0 font-mono text-11">
                    <span className="text-success">+{file.additions}</span>{" "}
                    <span className="text-error">−{file.deletions}</span>
                </span>
                {renderMs != null ? (
                    <span className="ml-auto shrink-0 text-11 text-muted" data-testid="review-render-ms">
                        {renderMs} ms
                    </span>
                ) : null}
            </div>
            <CommentsStrip model={model} path={file.path} />
            <DiffBody model={model} file={file} view={view} mode={mode} />
        </div>
    );
}

function DiffBody({
    model,
    file,
    view,
    mode,
}: {
    model: ReviewViewModel;
    file: ReviewFile;
    view: ReviewFileView;
    mode: string;
}) {
    const collapsed =
        view.result?.collapsed || (view.result == null && !view.loading && !view.error ? file.collapsed : "");
    if (view.error) {
        return (
            <EmptyState
                icon="triangle-exclamation"
                title="This file could not be read"
                hint="git could not read one of its sides."
                primary={{ label: "Try again", onClick: () => model.selectFile(file.path) }}
                details={view.error}
            />
        );
    }
    if (view.loading) {
        return <div className="flex flex-1 items-center justify-center text-12 text-muted">Reading {file.path}…</div>;
    }
    if (collapsed) {
        const binary = collapsed === "binary" || view.result?.binary;
        const lines = binary ? 0 : Math.max(view.result?.oldlines ?? 0, view.result?.newlines ?? 0);
        // A binary side is never sent as text, so Load would show nothing more.
        const canLoad = collapsed !== "submodule" && !binary;
        return (
            <div
                className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
                data-testid="review-collapsed"
            >
                <i className="fa fa-solid fa-file-zipper text-icon-20 text-muted" />
                <div className="text-13 font-medium">{collapsedReason(collapsed, file)}</div>
                <div className="text-12 text-muted">
                    {binary
                        ? `${formatBytes(file.oldsize ?? 0)} → ${formatBytes(file.newsize ?? 0)}`
                        : `+${file.additions} −${file.deletions}`}
                    {lines > 0 ? ` · ${lines.toLocaleString()} lines` : ""}
                </div>
                {canLoad ? (
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12"
                        onClick={() => model.loadFile(file.path)}
                        data-testid="review-load"
                    >
                        Load the diff
                        <MoltenWave />
                    </button>
                ) : null}
            </div>
        );
    }
    if (view.result == null) {
        return null;
    }
    return (
        <MonacoDiff
            key={`${mode}:${view.key}`}
            model={model}
            path={`${model.blockId}/${mode}/${file.path}`}
            original={view.result.original}
            modified={view.result.modified}
            language={languageOf(file.path)}
            askedAt={view.askedAt}
        />
    );
}

function MonacoDiff({
    model,
    path,
    original,
    modified,
    language,
    askedAt,
}: {
    model: ReviewViewModel;
    path: string;
    original: string;
    modified: string;
    language: string;
    askedAt: number;
}) {
    const sideBySideToggle = useAtomValue(model.sideBySideAtom);
    const inlineDiff = useOverrideConfigAtom(model.blockId, "editor:inlinediff");
    const minimap = useOverrideConfigAtom(model.blockId, "editor:minimapenabled") ?? false;
    const fontSize = boundNumber(useOverrideConfigAtom(model.blockId, "editor:fontsize"), 6, 64);
    const sideBySide = sideBySideOf(sideBySideToggle, inlineDiff);
    const options = useMemo<MonacoTypes.editor.IDiffEditorOptions>(
        () => ({
            readOnly: true,
            originalEditable: false,
            renderSideBySide: sideBySide,
            // The toggle decides, not the pane's width.
            useInlineViewWhenSpaceIsLimited: false,
            hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5, revealLineCount: 20 },
            scrollBeyondLastLine: false,
            fontSize: fontSize ?? 12,
            fontFamily: "Hack",
            smoothScrolling: true,
            minimap: { enabled: minimap },
            scrollbar: { useShadows: false, verticalScrollbarSize: 5, horizontalScrollbarSize: 5 },
            renderOverviewRuler: true,
            // The review comments' marks (FR-REV-003).
            glyphMargin: true,
        }),
        [sideBySide, fontSize, minimap]
    );
    return (
        <div className="relative min-h-0 flex-1">
            <MonacoDiffViewer
                path={path}
                original={original}
                modified={modified}
                language={language}
                options={options}
                onMount={(diff, monacoApi) => model.onDiffMount(diff, monacoApi, askedAt)}
            />
            <SelectionOverlay model={model} />
        </div>
    );
}
