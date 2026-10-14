// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab's state (FR-REV-002, DS-REV-002, DS-REV-012): one per molten-review block. It reads the PR from the
// block's meta, the file list and one file at a time from wavesrv, the viewed marks and the heads shown from the review
// store, and the PR's head as GitHub has it from the Reviews answer (Mission Control's collector, no poller of its
// own). It also keeps the Monaco diff editor and its line selection (FR-REV-003): the Ask the AI and Comment actions,
// the comments in the gutter and their anchors after a push.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import { ReviewsEvent, reviewsGet } from "../reviews/reviews-client";
import { ReviewsAnswer } from "../reviews/reviews-model";
import { TabActivity, whileShown } from "../tab-activity";
import { answerKey } from "./review-answers";
import { confirmAgentWorktree, ReviewWorktreeRisk } from "./review-cleanup";
import {
    discussReviewComment,
    openReviewAiPane,
    relocateReviewComments,
    ReviewBriefing,
    ReviewComment,
    ReviewCommentAction,
    ReviewCommentKind,
    ReviewCommentSubject,
    reviewCompare,
    ReviewDiscussResult,
    ReviewFile,
    reviewFile,
    ReviewFileResult,
    reviewFiles,
    ReviewFilesResult,
    reviewMerge,
    reviewMergeCancel,
    ReviewMergePlan,
    reviewMergePlan,
    ReviewPrInfo,
    ReviewPrMetaKey,
    ReviewState,
    reviewState,
    ReviewWorktree,
    reviewWorktree,
    saveReviewComment,
    setReviewCommentState,
    setReviewShown,
    setReviewViewed,
    subscribeReviewState,
    useReviewRewrite,
} from "./review-client";
import { attachDiffActions, DiffActions } from "./review-diff-actions";
import { mergeRunning } from "./review-merge";
import {
    buildFileTree,
    FileLink,
    firstFile,
    isViewed,
    MoltentermReviewAiView,
    MoltentermReviewView,
    reviewKey,
    treeFiles,
    TreeNode,
} from "./review-model";
import { developerLanguage, ReviewSelection, stagedCount } from "./review-selection";
import {
    askReviewBriefing,
    askReviewSession,
    cancelReviewQuestion,
    getReviewSession,
    ReviewAnchor,
    ReviewAskResult,
    ReviewBriefResult,
    ReviewSessionInfo,
    setReviewSessionHead,
    startReviewSession,
    subscribeReviewSession,
} from "./review-session";

// The PR's head is asked from the collector at most this often while the tab shows (it reads GitHub at most once a
// minute per project, NFR-REV-002).
const HeadCheckMs = 30_000;

export type ReviewMode = "full" | "since";

export type ReviewFileView = {
    path: string;
    // The request's identity: a slower answer for another file is dropped.
    key: string;
    loading: boolean;
    result?: ReviewFileResult;
    error?: string;
    // When the file was asked for, for NFR-REV-001's render budget.
    askedAt: number;
};

export type ReviewNewCommits = { to: string; baseoid?: string; commits: number; rewritten?: boolean };

export type ReviewWorktreeState = { state: "pending" | "ready" | "failed"; worktree?: ReviewWorktree; error?: string };

// Validate's plan sheet (FR-REV-012): the plan read on opening it, the developer's confirmation of its warnings, and
// the plan whose merge was clicked, so the sheet follows that merge in the review store.
export type ReviewValidateState = {
    open: boolean;
    loading: boolean;
    plan?: ReviewMergePlan;
    error?: string;
    override: boolean;
    clicked?: string;
    // The agent worktree's removal the developer confirmed after the merge's cleanup is running.
    confirming?: boolean;
};

// Where the selection's toolbar or the comment box shows over the diff, in pixels from its top left corner.
export type ReviewOverlayPos = { top: number; left: number; visible: boolean };

// The inline comment box: a new comment on the selection, or the text of an existing one (id).
export type ReviewComposer = {
    id?: string;
    anchor: ReviewAnchor;
    subject: ReviewCommentSubject;
    // comment: a remark or question for the author; change: a change request (FR-REV-009 AC1).
    kind: ReviewCommentKind;
    filereason?: string;
    text: string;
    saving?: boolean;
    error?: string;
};

// What Discuss on a comment did: sent (the reply comes under the comment), or why not.
export type ReviewDiscussOutcome = { result?: ReviewDiscussResult; error?: string };

// Ask the AI's box in the AI panel: the selection it is about (none: the PR) and what sending did.
export type ReviewAsk = {
    anchor?: ReviewAnchor;
    text?: string;
    // Bumped by each Ask the AI, so the box takes the focus again.
    seq: number;
    sending?: boolean;
    result?: ReviewAskResult;
    error?: string;
};

export type ReviewAiState = {
    status: "idle" | "starting" | "running" | "noagent" | "failed";
    message?: string;
    session?: ReviewSessionInfo;
};

// The answer group the AI panel brings into view and highlights (a gutter marker's click); seq bumps on each ask.
export type ReviewAnswerFocus = { key: string; seq: number };

// What asking the agent for a briefing gave (FR-REV-005 AC4).
export type ReviewBriefAsk = { status: "idle" | "asking" | ReviewBriefResult["status"]; message?: string; at?: number };

// The Review tabs' models by PR (reviewKey), so the AI panel, a block of its own, reaches its PR's review.
export const ReviewTabModels = atom(new Map<string, ReviewTabModel>()) as PrimitiveAtom<Map<string, ReviewTabModel>>;

function registerModel(key: string, model: ReviewTabModel) {
    globalStore.set(ReviewTabModels, (models) => new Map(models).set(key, model));
}

function unregisterModel(key: string, model: ReviewTabModel) {
    if (globalStore.get(ReviewTabModels).get(key) !== model) {
        return;
    }
    globalStore.set(ReviewTabModels, (models) => {
        const next = new Map(models);
        next.delete(key);
        return next;
    });
}

// The view (review-view.tsx) subclasses it with its component.
export abstract class ReviewTabModel implements ViewModel {
    abstract get viewComponent(): ViewComponent;
    viewType = MoltentermReviewView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("code-compare");
    viewName: Atom<string>;
    noPadding = atom(true);

    prAtom: Atom<ReviewPrInfo>;
    // The head the tab shows, and the diff's mode: the PR's whole diff or the one since the last round.
    headAtom = atom(null) as PrimitiveAtom<string>;
    modeAtom = atom("full") as PrimitiveAtom<ReviewMode>;
    filesAtom = atom(null) as PrimitiveAtom<ReviewFilesResult>;
    filesLoadingAtom = atom(false) as PrimitiveAtom<boolean>;
    filesErrorAtom = atom(null) as PrimitiveAtom<string>;
    stateAtom = atom(null) as PrimitiveAtom<ReviewState>;
    selectedAtom = atom(null) as PrimitiveAtom<string>;
    fileAtom = atom(null) as PrimitiveAtom<ReviewFileView>;
    // Files the developer asked to Load although collapsed (AC3).
    loadedAtom = atom(new Set<string>()) as PrimitiveAtom<Set<string>>;
    // null: the editor:inlinediff setting decides (AC2).
    sideBySideAtom = atom(null) as PrimitiveAtom<boolean>;
    newCommitsAtom = atom(null) as PrimitiveAtom<ReviewNewCommits>;
    worktreeAtom = atom({ state: "pending" }) as PrimitiveAtom<ReviewWorktreeState>;
    aiAtom = atom({ status: "idle" }) as PrimitiveAtom<ReviewAiState>;
    briefAskAtom = atom({ status: "idle" }) as PrimitiveAtom<ReviewBriefAsk>;
    renderMsAtom = atom(null) as PrimitiveAtom<number>;
    validateAtom = atom({ open: false, loading: false, override: false }) as PrimitiveAtom<ReviewValidateState>;
    // FR-REV-003: the lines selected in the diff, where their actions show, the comment box and Ask the AI's box.
    selectionAtom = atom(null) as PrimitiveAtom<ReviewSelection>;
    overlayAtom = atom(null) as PrimitiveAtom<ReviewOverlayPos>;
    composerAtom = atom(null) as PrimitiveAtom<ReviewComposer>;
    askAtom = atom(null) as PrimitiveAtom<ReviewAsk>;
    // FR-REV-006: the answer group a gutter marker asked the AI panel to show.
    answerFocusAtom = atom(null) as PrimitiveAtom<ReviewAnswerFocus>;

    treeAtom: Atom<TreeNode[]>;
    orderedFilesAtom: Atom<ReviewFile[]>;
    viewedCountAtom: Atom<number>;
    briefingAtom: Atom<ReviewBriefing>;
    // The comments the next publication takes (Publish review's count, FR-REV-009 AC4).
    stagedCountAtom: Atom<number>;
    // The AI panel's block in this tab, null when it is closed (DS-REV-012).
    aiPaneIdAtom: Atom<string>;

    // The Monaco diff editor on screen (MonacoDiffViewer's onMount); FR-REV-003's selection reads it.
    diffEditor: MonacoTypes.editor.IStandaloneDiffEditor = null;
    diffActions: DiffActions = null;
    started = false;
    cleanups: (() => void)[] = [];
    fileSeq = 0;
    // The base branch's tip as GitHub gave it with the head shown.
    baseOid: string = null;
    checkingHead = false;
    // The head the session was last moved to (one request per head).
    sessionHeadAsked: string = null;
    // A line a briefing link or an answer card asked for (on its side), shown once its file's diff is on screen.
    pendingReveal: FileLink & { side?: string } = null;
    registeredKey: string = null;

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId));
        this.prAtom = atom((get) => (get(blockAtom)?.meta?.[ReviewPrMetaKey] as ReviewPrInfo) ?? null);
        this.viewName = atom((get) => {
            const pr = get(this.prAtom);
            return pr ? `Review #${pr.number}` : "Review";
        });
        this.treeAtom = atom((get) => buildFileTree(get(this.filesAtom)?.files ?? []));
        this.orderedFilesAtom = atom((get) => treeFiles(get(this.treeAtom)));
        this.viewedCountAtom = atom((get) => {
            const state = get(this.stateAtom);
            return (get(this.filesAtom)?.files ?? []).filter((f) => isViewed(state, f)).length;
        });
        this.briefingAtom = atom((get) => get(this.stateAtom)?.briefing ?? null);
        this.stagedCountAtom = atom((get) => stagedCount(get(this.stateAtom)));
        this.aiPaneIdAtom = atom((get) => {
            const pr = get(this.prAtom);
            const tabId = get(atoms.staticTabId);
            if (pr == null || !tabId) {
                return null;
            }
            const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
            const key = reviewKey(pr.repo, pr.number);
            for (const id of tab?.blockids ?? []) {
                const meta = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", id)))?.meta;
                const paneOf = meta?.[ReviewPrMetaKey] as ReviewPrInfo;
                if (
                    meta?.view === MoltentermReviewAiView &&
                    paneOf != null &&
                    reviewKey(paneOf.repo, paneOf.number) === key
                ) {
                    return id;
                }
            }
            return null;
        });
    }

    pr(): ReviewPrInfo {
        return globalStore.get(this.prAtom);
    }

    // start runs once the view mounts with its PR; the returned function stops what it started.
    start(): () => void {
        const pr = this.pr();
        if (pr == null || this.started) {
            return () => {};
        }
        this.started = true;
        this.registeredKey = reviewKey(pr.repo, pr.number);
        registerModel(this.registeredKey, this);
        this.cleanups.push(
            subscribeReviewState(pr.repo, pr.number, (state) => this.applyState(state)),
            subscribeReviewSession(pr.repo, pr.number, (update) => {
                if (update.ended) {
                    globalStore.set(this.aiAtom, (ai) => ({ ...ai, status: "idle", session: null }));
                    globalStore.set(this.briefAskAtom, { status: "idle" });
                    this.sessionHeadAsked = null;
                    return;
                }
                if (update.session != null) {
                    this.applySession(update.session);
                }
            }),
            waveEventSubscribeSingle({
                eventType: ReviewsEvent as WaveEventName,
                scope: pr.dir,
                handler: (event) => this.applyReviews(event.data as ReviewsAnswer),
            }),
            TabActivity.getInstance().every(whileShown(HeadCheckMs), () => this.checkHead(), "review-head")
        );
        const onFocus = () => this.checkHead();
        window.addEventListener("focus", onFocus);
        this.cleanups.push(() => window.removeEventListener("focus", onFocus));
        fireAndForget(() => this.open());
        return () => this.stop();
    }

    stop() {
        for (const cleanup of this.cleanups) {
            cleanup();
        }
        this.cleanups = [];
        this.started = false;
        this.diffEditor = null;
        if (this.registeredKey != null) {
            unregisterModel(this.registeredKey, this);
            this.registeredKey = null;
        }
    }

    // open shows the head the developer read last (the store's), else the PR's newest; a newer head shows as new
    // commits (AC5). A session already running for the PR (a restart, a reopened tab) shows in the AI panel.
    async open() {
        const pr = this.pr();
        let state: ReviewState = null;
        try {
            state = await reviewState(pr.repo, pr.number);
            globalStore.set(this.stateAtom, state);
        } catch (e) {
            console.log("[review] the review store could not be read", e);
        }
        const latest = await this.latestPr();
        const head = state?.lasthead || latest?.headoid || pr.headoid;
        await this.loadFiles(head, latest?.baseoid || pr.baseoid);
        fireAndForget(() => this.checkHead());
        fireAndForget(async () => {
            const session = await getReviewSession({ repo: pr.repo, number: pr.number });
            if (session != null) {
                this.applySession(session);
            }
        });
    }

    async latestPr(): Promise<{ headoid?: string; baseoid?: string }> {
        const pr = this.pr();
        try {
            const answer = await reviewsGet(pr.dir);
            return this.prOf(answer);
        } catch {
            return null;
        }
    }

    prOf(answer: ReviewsAnswer): { headoid?: string; baseoid?: string } {
        const pr = this.pr();
        if (answer == null || answer.dir !== pr?.dir) {
            return null;
        }
        return [...(answer.ready ?? []), ...(answer.drafts ?? [])].find((p) => p.number === pr.number) ?? null;
    }

    applyReviews(answer: ReviewsAnswer) {
        const latest = this.prOf(answer);
        if (latest?.headoid) {
            fireAndForget(() => this.noticeHead(latest.headoid, latest.baseoid));
        }
    }

    // checkHead asks the collector for the PR's head (within its limits) and notices a move.
    async checkHead() {
        if (this.checkingHead || this.pr() == null) {
            return;
        }
        this.checkingHead = true;
        try {
            const latest = await this.latestPr();
            if (latest?.headoid) {
                await this.noticeHead(latest.headoid, latest.baseoid);
            }
        } finally {
            this.checkingHead = false;
        }
    }

    async noticeHead(headoid: string, baseoid: string) {
        const shown = globalStore.get(this.headAtom);
        if (!shown || headoid === shown) {
            globalStore.set(this.newCommitsAtom, null);
            return;
        }
        const known = globalStore.get(this.newCommitsAtom);
        if (known?.to === headoid) {
            return;
        }
        const pr = this.pr();
        try {
            const cmp = await reviewCompare({ dir: pr.dir, headref: pr.headref, from: shown, to: headoid });
            globalStore.set(this.newCommitsAtom, {
                to: headoid,
                baseoid,
                commits: cmp.commits,
                rewritten: cmp.rewritten,
            });
        } catch (e) {
            console.log("[review] the new commits could not be counted", e);
            globalStore.set(this.newCommitsAtom, { to: headoid, baseoid, commits: 0, rewritten: true });
        }
    }

    // refresh moves the tab to the PR's new head (AC5): the full diff again, and the "since last round" diff offered.
    async refresh() {
        const next = globalStore.get(this.newCommitsAtom);
        if (next == null) {
            return;
        }
        globalStore.set(this.newCommitsAtom, null);
        globalStore.set(this.modeAtom, "full");
        await this.loadFiles(next.to, next.baseoid);
    }

    async loadFiles(head: string, baseoid: string) {
        if (baseoid) {
            this.baseOid = baseoid;
        }
        const pr = this.pr();
        const mode = globalStore.get(this.modeAtom);
        const since = globalStore.get(this.stateAtom)?.since;
        globalStore.set(this.filesLoadingAtom, true);
        globalStore.set(this.filesErrorAtom, null);
        try {
            const result = await reviewFiles({
                dir: pr.dir,
                headref: pr.headref,
                baseref: pr.baseref,
                headoid: mode === "since" && since ? since.to : head || undefined,
                baseoid: this.baseOid || undefined,
                from: mode === "since" && since ? since.from : undefined,
            });
            console.log(
                `[review] ${pr.repo}#${pr.number} ${mode}: ${result.files.length} files in ${result.ms} ms${result.cached ? " (cached)" : ""}`
            );
            globalStore.set(this.filesAtom, result);
            if (mode === "full") {
                this.headShown(result.headoid);
                fireAndForget(() => this.relocate(result.headoid, result.baseoid));
            }
            const files = globalStore.get(this.orderedFilesAtom);
            const selected = globalStore.get(this.selectedAtom);
            const keep = files.find((f) => f.path === selected);
            const next = keep ?? firstFile(files);
            if (next != null) {
                this.selectFile(next.path);
            } else {
                globalStore.set(this.selectedAtom, null);
                globalStore.set(this.fileAtom, null);
            }
        } catch (e) {
            globalStore.set(this.filesErrorAtom, String(e?.message ?? e));
        } finally {
            globalStore.set(this.filesLoadingAtom, false);
        }
    }

    headShown(head: string) {
        const pr = this.pr();
        const previous = globalStore.get(this.headAtom);
        globalStore.set(this.headAtom, head);
        fireAndForget(async () => {
            const state = await setReviewShown(pr.repo, pr.number, head);
            globalStore.set(this.stateAtom, state);
        });
        if (previous !== head) {
            fireAndForget(() => this.prepareWorktree(head));
        }
    }

    // The review worktree follows the head shown (DS-REV-004); the diff itself never needs it.
    async prepareWorktree(head: string) {
        const pr = this.pr();
        globalStore.set(this.worktreeAtom, { state: "pending" });
        try {
            const worktree = await reviewWorktree({
                dir: pr.dir,
                number: pr.number,
                headref: pr.headref,
                headoid: head,
            });
            if (globalStore.get(this.headAtom) === head) {
                globalStore.set(this.worktreeAtom, { state: "ready", worktree });
            }
        } catch (e) {
            globalStore.set(this.worktreeAtom, { state: "failed", error: String(e?.message ?? e) });
        }
        await this.syncSessionHead();
    }

    // syncSessionHead moves a running session to the head shown, once the worktree followed it, and asks for a new
    // briefing when the kept one is of another head (FR-REV-005 AC4, #580's follow-up).
    async syncSessionHead() {
        const session = globalStore.get(this.aiAtom).session;
        const head = globalStore.get(this.headAtom);
        if (session == null || !head || session.headoid === head || this.sessionHeadAsked === head) {
            return;
        }
        if (globalStore.get(this.worktreeAtom).state === "pending") {
            return;
        }
        this.sessionHeadAsked = head;
        const brief = globalStore.get(this.briefingAtom)?.headoid !== head;
        try {
            const result = await setReviewSessionHead({ id: session.id }, head, brief);
            if (brief) {
                this.applyBriefAsk(result);
            }
        } catch (e) {
            this.sessionHeadAsked = null;
            console.log("[review] the session could not follow the new head", e);
        }
    }

    applyBriefAsk(result: ReviewBriefResult) {
        globalStore.set(this.briefAskAtom, { status: result.status, message: result.message, at: Date.now() });
    }

    // askBriefing asks the running session for a new briefing (the card's Ask again, or after a busy refresh).
    async askBriefing() {
        const session = globalStore.get(this.aiAtom).session;
        if (session == null) {
            await this.openAi();
            return;
        }
        globalStore.set(this.briefAskAtom, { status: "asking" });
        try {
            this.applyBriefAsk(await askReviewBriefing({ id: session.id }));
        } catch (e) {
            globalStore.set(this.briefAskAtom, { status: "failed", message: String(e?.message ?? e) });
        }
    }

    // revealFile shows a file of the PR at a line, from a briefing link; false when the PR has no such file.
    revealFile(link: FileLink): boolean {
        const files = globalStore.get(this.filesAtom)?.files ?? [];
        const file = files.find((f) => f.path === link.path) ?? files.find((f) => f.path.endsWith("/" + link.path));
        if (file == null) {
            return false;
        }
        this.pendingReveal = { path: file.path, line: link.line };
        if (globalStore.get(this.selectedAtom) === file.path && this.diffEditor != null) {
            this.revealPending(this.diffEditor);
        } else {
            this.selectFile(file.path);
        }
        return true;
    }

    revealPending(diff: MonacoTypes.editor.IStandaloneDiffEditor) {
        const reveal = this.pendingReveal;
        if (reveal == null || reveal.path !== globalStore.get(this.selectedAtom)) {
            return;
        }
        this.pendingReveal = null;
        if (!(reveal.line > 0)) {
            return;
        }
        const editor = reveal.side === "LEFT" ? diff.getOriginalEditor() : diff.getModifiedEditor();
        editor.revealLineInCenter(reveal.line);
        editor.setSelection({ startLineNumber: reveal.line, startColumn: 1, endLineNumber: reveal.line, endColumn: 1 });
    }

    async setMode(mode: ReviewMode) {
        if (globalStore.get(this.modeAtom) === mode) {
            return;
        }
        globalStore.set(this.modeAtom, mode);
        const files = globalStore.get(this.filesAtom);
        await this.loadFiles(globalStore.get(this.headAtom) ?? files?.headoid, this.baseOid);
    }

    fileOf(path: string): ReviewFile {
        return (globalStore.get(this.filesAtom)?.files ?? []).find((f) => f.path === path) ?? null;
    }

    // selectFile shows one file (AC2, AC4): its two sides are read now, one file at a time.
    selectFile(path: string) {
        const file = this.fileOf(path);
        globalStore.set(this.selectedAtom, path);
        if (file == null) {
            return;
        }
        const load = globalStore.get(this.loadedAtom).has(path);
        const askedAt = performance.now();
        const key = `${++this.fileSeq}:${path}`;
        globalStore.set(this.renderMsAtom, null);
        if (file.collapsed && !load) {
            globalStore.set(this.fileAtom, { path, key, loading: false, askedAt });
            return;
        }
        globalStore.set(this.fileAtom, { path, key, loading: true, askedAt });
        const pr = this.pr();
        fireAndForget(async () => {
            try {
                const result = await reviewFile({
                    dir: pr.dir,
                    path,
                    oldblob: file.oldblob,
                    newblob: file.newblob,
                    load: load || undefined,
                });
                if (globalStore.get(this.fileAtom)?.key !== key) {
                    return;
                }
                globalStore.set(this.fileAtom, { path, key, loading: false, result, askedAt });
            } catch (e) {
                if (globalStore.get(this.fileAtom)?.key !== key) {
                    return;
                }
                globalStore.set(this.fileAtom, { path, key, loading: false, error: String(e?.message ?? e), askedAt });
            }
        });
    }

    loadFile(path: string) {
        globalStore.set(this.loadedAtom, (loaded) => new Set([...loaded, path]));
        this.selectFile(path);
    }

    toggleViewed(file: ReviewFile) {
        const pr = this.pr();
        const viewed = !isViewed(globalStore.get(this.stateAtom), file);
        fireAndForget(async () => {
            const state = await setReviewViewed(pr.repo, pr.number, file.path, file.newblob ?? "", viewed);
            globalStore.set(this.stateAtom, state);
        });
    }

    setSideBySide(sideBySide: boolean) {
        globalStore.set(this.sideBySideAtom, sideBySide);
    }

    onDiffMount(
        diff: MonacoTypes.editor.IStandaloneDiffEditor,
        monacoApi: typeof MonacoTypes,
        askedAt: number
    ): () => void {
        this.diffEditor = diff;
        const sub = diff.onDidUpdateDiff(() => {
            sub.dispose();
            const ms = Math.round(performance.now() - askedAt);
            globalStore.set(this.renderMsAtom, ms);
            console.log(`[review] ${globalStore.get(this.selectedAtom)} rendered in ${ms} ms`);
            this.revealPending(diff);
        });
        this.diffActions = monacoApi != null ? attachDiffActions(this, diff, monacoApi) : null;
        return () => {
            sub.dispose();
            this.diffActions?.dispose();
            this.diffActions = null;
            this.clearSelection();
            if (this.diffEditor === diff) {
                this.diffEditor = null;
            }
        };
    }

    // The anchors' head: the head the diff's right side shows.
    shownHead(): string {
        return globalStore.get(this.filesAtom)?.headoid ?? globalStore.get(this.headAtom);
    }

    clearSelection() {
        globalStore.set(this.selectionAtom, null);
        globalStore.set(this.composerAtom, null);
        globalStore.set(this.overlayAtom, null);
    }

    // askSelection is Ask the AI (AC2): the AI panel opens (its session starts) with the selection named and a box
    // for the question.
    askSelection() {
        const sel = globalStore.get(this.selectionAtom);
        const previous = globalStore.get(this.askAtom);
        globalStore.set(this.askAtom, {
            anchor: sel?.anchor,
            text: sel?.text,
            seq: (previous?.seq ?? 0) + 1,
        });
        globalStore.set(this.composerAtom, null);
        if (globalStore.get(this.aiPaneIdAtom) == null || globalStore.get(this.aiAtom).session == null) {
            fireAndForget(() => this.openAi());
        }
    }

    clearAskSelection() {
        globalStore.set(this.askAtom, (ask) => (ask ? { ...ask, anchor: null, text: null, result: null } : ask));
    }

    // sendAsk sends the question to the review session with the selection's reference; the session starts first when
    // it is not running.
    async sendAsk(question: string): Promise<boolean> {
        const ask = globalStore.get(this.askAtom);
        if (ask == null || question.trim() === "" || ask.sending) {
            return false;
        }
        const pr = this.pr();
        globalStore.set(this.askAtom, { ...ask, sending: true, error: null, result: null });
        try {
            if (globalStore.get(this.aiAtom).session == null) {
                await this.startSession();
            }
            const session = globalStore.get(this.aiAtom).session;
            if (session == null) {
                const ai = globalStore.get(this.aiAtom);
                throw new Error(ai.message || "The review session is not running.");
            }
            const result = await askReviewSession({ id: session.id }, ask.anchor, ask.text, question.trim());
            globalStore.set(this.askAtom, (cur) => ({ ...cur, sending: false, result }));
            return result.sent || !!result.queued;
        } catch (e) {
            console.log(`[review] ${pr.repo}#${pr.number}: the question could not be sent`, e);
            globalStore.set(this.askAtom, (cur) => ({ ...cur, sending: false, error: String(e?.message ?? e) }));
            return false;
        }
    }

    // cancelQuestion removes a queued question (FR-REV-006 AC4); the session's update shows the queue without it.
    async cancelQuestion(questionid: string): Promise<string> {
        const session = globalStore.get(this.aiAtom).session;
        if (session == null) {
            return null;
        }
        try {
            await cancelReviewQuestion({ id: session.id }, questionid);
            return null;
        } catch (e) {
            return String(e?.message ?? e);
        }
    }

    // showAnswer is a gutter marker's click (FR-REV-006 AC2): the AI panel opens, without starting a session, and
    // brings the answers on those lines into view.
    showAnswer(anchor: ReviewAnchor) {
        const previous = globalStore.get(this.answerFocusAtom);
        globalStore.set(this.answerFocusAtom, { key: answerKey(anchor), seq: (previous?.seq ?? 0) + 1 });
        if (globalStore.get(this.aiPaneIdAtom) != null) {
            return;
        }
        const pr = this.pr();
        fireAndForget(async () => {
            await openReviewAiPane(globalStore.get(atoms.staticTabId), this.blockId, pr);
        });
    }

    // revealAnchor shows an answer's lines in the diff, on their side (an answer card's link).
    revealAnchor(anchor: ReviewAnchor): boolean {
        if (anchor == null || this.fileOf(anchor.path) == null) {
            return false;
        }
        this.pendingReveal = { path: anchor.path, line: anchor.startline ?? anchor.line, side: anchor.side };
        if (globalStore.get(this.selectedAtom) === anchor.path && this.diffEditor != null) {
            this.revealPending(this.diffEditor);
        } else {
            this.selectFile(anchor.path);
        }
        return true;
    }

    // openComposer is Comment (AC3, AC4): a line comment inside a hunk, a file-level one quoting the lines elsewhere.
    openComposer() {
        const sel = globalStore.get(this.selectionAtom);
        if (sel == null) {
            return;
        }
        globalStore.set(this.composerAtom, {
            anchor: sel.anchor,
            subject: sel.linecomment ? "line" : "file",
            kind: "comment",
            filereason: sel.filereason,
            text: "",
        });
    }

    editComment(comment: ReviewComment) {
        globalStore.set(this.composerAtom, {
            id: comment.id,
            anchor: comment.anchor,
            subject: comment.subject,
            kind: comment.kind,
            text: comment.original.text,
        });
    }

    closeComposer() {
        globalStore.set(this.composerAtom, null);
    }

    async saveComment(composer: ReviewComposer, text: string, kind: ReviewCommentKind): Promise<boolean> {
        const pr = this.pr();
        globalStore.set(this.composerAtom, { ...composer, text, kind, saving: true, error: null });
        try {
            const state = await saveReviewComment(pr.repo, pr.number, {
                id: composer.id,
                anchor: composer.id ? undefined : composer.anchor,
                subject: composer.id ? undefined : composer.subject,
                kind,
                text,
                lang: composer.id ? undefined : developerLanguage(navigator.language),
            });
            globalStore.set(this.stateAtom, state);
            this.clearSelection();
            this.diffActions?.collapseSelection();
            return true;
        } catch (e) {
            globalStore.set(this.composerAtom, (cur) =>
                cur ? { ...cur, text, kind, saving: false, error: String(e?.message ?? e) } : cur
            );
            return false;
        }
    }

    // A comment's own text and kind change from the comments lists (its anchor stays).
    async updateComment(comment: ReviewComment, text: string, kind: ReviewCommentKind): Promise<string> {
        const pr = this.pr();
        try {
            const state = await saveReviewComment(pr.repo, pr.number, { id: comment.id, text, kind });
            globalStore.set(this.stateAtom, state);
            return null;
        } catch (e) {
            return String(e?.message ?? e);
        }
    }

    // commentAction stages, unstages, drops, restores or accepts (a proposal) a comment (FR-REV-009 AC1, AC3). A dropped
    // comment stays in the store with its history.
    async commentAction(comment: ReviewComment, action: ReviewCommentAction): Promise<string> {
        const pr = this.pr();
        try {
            const state = await setReviewCommentState(pr.repo, pr.number, comment.id, action);
            globalStore.set(this.stateAtom, state);
            if (action === "drop" && globalStore.get(this.composerAtom)?.id === comment.id) {
                globalStore.set(this.composerAtom, null);
            }
            return null;
        } catch (e) {
            return String(e?.message ?? e);
        }
    }

    // useRewrite takes or ignores the rewrite the agent proposed in a reply (AC2).
    async useRewrite(comment: ReviewComment, messageId: string, accept: boolean): Promise<string> {
        const pr = this.pr();
        try {
            const state = await useReviewRewrite(pr.repo, pr.number, comment.id, messageId, accept);
            globalStore.set(this.stateAtom, state);
            return null;
        } catch (e) {
            return String(e?.message ?? e);
        }
    }

    // discussComment is Discuss (AC2): the comment and its lines go to the review session, started first (with the
    // AI panel) when it is not running; the agent's reply comes under the comment.
    async discussComment(comment: ReviewComment, message: string): Promise<ReviewDiscussOutcome> {
        const pr = this.pr();
        try {
            if (globalStore.get(this.aiAtom).session == null) {
                await this.openAi();
            }
            if (globalStore.get(this.aiAtom).session == null) {
                const ai = globalStore.get(this.aiAtom);
                return { error: ai.message || "The review session is not running." };
            }
            const result = await discussReviewComment(pr.repo, pr.number, comment.id, message.trim());
            if (result.state != null) {
                globalStore.set(this.stateAtom, result.state);
            }
            return { result };
        } catch (e) {
            console.log(`[review] ${pr.repo}#${pr.number}: the comment could not be discussed`, e);
            return { error: String(e?.message ?? e) };
        }
    }

    revealComment(comment: ReviewComment) {
        this.diffActions?.reveal(comment);
    }

    // relocate re-anchors the comments made on another head to the head shown (AC5); nothing to do, no call.
    async relocate(headoid: string, baseoid: string) {
        const pr = this.pr();
        const comments = globalStore.get(this.stateAtom)?.comments ?? [];
        const stale = comments.some(
            (c) => c.state !== "published" && c.state !== "dropped" && c.anchor?.headoid !== headoid
        );
        if (!stale || !headoid || !baseoid) {
            return;
        }
        try {
            const state = await relocateReviewComments({
                repo: pr.repo,
                number: pr.number,
                dir: pr.dir,
                headoid,
                baseoid,
            });
            globalStore.set(this.stateAtom, state);
        } catch (e) {
            console.log("[review] the comments could not be moved to the new head", e);
        }
    }

    applySession(session: ReviewSessionInfo) {
        const status = session.state === "failed" ? "failed" : session.state === "starting" ? "starting" : "running";
        globalStore.set(this.aiAtom, (ai) => ({ ...ai, status, session, message: session.message }));
        fireAndForget(() => this.syncSessionHead());
    }

    // openPublish is Publish review: the staged comments, in the AI panel. Posting them on GitHub after the developer's
    // click is FR-REV-010's.
    async openPublish() {
        if (globalStore.get(this.aiPaneIdAtom) != null) {
            return;
        }
        await this.openAi();
    }

    // The AI panel (DS-REV-012) is a pane of its own right of this block, the session's terminal split under it, so the
    // briefing and the explanation cards sit above the agent's terminal. Closing it keeps the session; the session
    // ends when its terminal or the tab closes.
    async toggleAi() {
        const paneId = globalStore.get(this.aiPaneIdAtom);
        if (paneId == null) {
            await this.openAi();
            return;
        }
        const layout = getLayoutModelForStaticTab();
        const node = layout?.getNodeByBlockId(paneId);
        if (node != null) {
            await layout.closeNode(node.id);
        }
    }

    // openAi opens the AI panel and starts the PR's review session when it has none (FR-REV-004).
    async openAi() {
        const pr = this.pr();
        let paneId = globalStore.get(this.aiPaneIdAtom);
        try {
            if (paneId == null) {
                paneId = (await openReviewAiPane(globalStore.get(atoms.staticTabId), this.blockId, pr)).blockid;
            }
        } catch (e) {
            console.log("[review] the AI panel could not be opened", e);
        }
        const ai = globalStore.get(this.aiAtom);
        if (ai.session == null && ai.status !== "starting") {
            await this.startSession(paneId);
        }
    }

    async startSession(afterBlockId?: string) {
        const pr = this.pr();
        const head = globalStore.get(this.headAtom) ?? pr.headoid;
        // A briefing kept for this head is shown again; the agent is asked for one otherwise (FR-REV-005 AC4).
        const brief = globalStore.get(this.briefingAtom)?.headoid !== head || head == null;
        globalStore.set(this.aiAtom, (ai) => ({ ...ai, status: "starting", message: null }));
        try {
            const result = await startReviewSession({
                tabid: globalStore.get(atoms.staticTabId),
                projectdir: pr.dir,
                repo: pr.repo,
                number: pr.number,
                title: pr.title,
                headref: pr.headref,
                headoid: head,
                baseref: pr.baseref,
                brief,
                afterblockid: afterBlockId ?? globalStore.get(this.aiPaneIdAtom) ?? undefined,
            });
            if (result.status === "started" && brief) {
                globalStore.set(this.briefAskAtom, { status: "asked", at: Date.now() });
            }
            switch (result.status) {
                case "started":
                case "attached":
                    this.applySession(result.session);
                    return;
                case "noagent":
                    globalStore.set(this.aiAtom, (ai) => ({ ...ai, status: "noagent", message: result.message }));
                    return;
            }
            globalStore.set(this.aiAtom, (ai) => ({ ...ai, status: "failed", message: result.message }));
        } catch (e) {
            globalStore.set(this.aiAtom, (ai) => ({ ...ai, status: "failed", message: String(e?.message ?? e) }));
        }
    }

    // applyState takes the store's state; a merge that just ended refreshes the Reviews list once (DS-REV-001: right
    // after a MoltenTerm action).
    applyState(state: ReviewState) {
        const before = globalStore.get(this.stateAtom)?.merge;
        globalStore.set(this.stateAtom, state);
        const after = state?.merge;
        if (after == null || !mergeRunning(before) || mergeRunning(after) || before.planid !== after.planid) {
            return;
        }
        const pr = this.pr();
        fireAndForget(async () => {
            await reviewsGet(pr.dir, true);
        });
    }

    // Validate (FR-REV-012, AC1): the plan sheet opens on a fresh read of the PR. Nothing merges until Merge is
    // clicked on it.
    async openValidate() {
        globalStore.set(this.validateAtom, { open: true, loading: true, override: false });
        await this.loadPlan();
    }

    async loadPlan() {
        const pr = this.pr();
        globalStore.set(this.validateAtom, (v) => ({ ...v, loading: true, error: null }));
        try {
            const plan = await reviewMergePlan({ dir: pr.dir, repo: pr.repo, number: pr.number, ticket: pr.ticket });
            globalStore.set(this.validateAtom, (v) => (v.open ? { ...v, loading: false, plan, override: false } : v));
        } catch (e) {
            globalStore.set(this.validateAtom, (v) => ({ ...v, loading: false, error: String(e?.message ?? e) }));
        }
    }

    closeValidate() {
        globalStore.set(this.validateAtom, { open: false, loading: false, override: false });
    }

    setValidateOverride(override: boolean) {
        globalStore.set(this.validateAtom, (v) => ({ ...v, override }));
    }

    // merge is the developer's click (AC5): wavesrv checks the plan and the head again, then reports in the store.
    async merge() {
        const pr = this.pr();
        const v = globalStore.get(this.validateAtom);
        if (v.plan == null) {
            return;
        }
        globalStore.set(this.validateAtom, (s) => ({ ...s, clicked: v.plan.id, error: null }));
        try {
            const record = await reviewMerge(pr.repo, pr.number, v.plan.id, v.override);
            // The store's event may have come first with a newer step of this merge.
            globalStore.set(this.stateAtom, (state) =>
                state && state.merge?.planid !== record.planid ? { ...state, merge: record } : state
            );
        } catch (e) {
            globalStore.set(this.validateAtom, (s) => ({ ...s, clicked: null, error: String(e?.message ?? e) }));
        }
    }

    async cancelMerge() {
        const pr = this.pr();
        try {
            await reviewMergeCancel(pr.repo, pr.number);
        } catch (e) {
            globalStore.set(this.validateAtom, (s) => ({ ...s, error: String(e?.message ?? e) }));
        }
    }

    // The agent worktree the merge's cleanup kept for its risk (FR-REV-013): removed on the developer's second
    // confirmation of the plan shown; the outcome comes back in the review store.
    async confirmCleanupWorktree(risk: ReviewWorktreeRisk) {
        const pr = this.pr();
        const ticket = globalStore.get(this.validateAtom).plan?.ticket;
        globalStore.set(this.validateAtom, (s) => ({ ...s, confirming: true, error: null }));
        try {
            await confirmAgentWorktree({ dir: pr.dir, repo: pr.repo, number: pr.number, ticket }, risk);
        } catch (e) {
            globalStore.set(this.validateAtom, (s) => ({ ...s, error: String(e?.message ?? e) }));
        } finally {
            globalStore.set(this.validateAtom, (s) => ({ ...s, confirming: false }));
        }
    }

    // After a refusal on new commits (AC2): the sheet closes and the tab shows the PR's new head.
    async reviewNewCommits() {
        this.closeValidate();
        try {
            const latest = this.prOf(await reviewsGet(this.pr().dir, true));
            if (latest?.headoid) {
                await this.noticeHead(latest.headoid, latest.baseoid);
            }
        } catch (e) {
            console.log("[review] the pull request's head could not be read", e);
        }
        await this.refresh();
    }

    dispose() {
        this.stop();
    }
}
