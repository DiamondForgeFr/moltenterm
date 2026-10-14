// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab's state (FR-REV-002, DS-REV-002, DS-REV-012): one per molten-review block. It reads the PR from the
// block's meta, the file list and one file at a time from wavesrv, the viewed marks and the heads shown from the review
// store, and the PR's head as GitHub has it from the Reviews answer (Mission Control's collector, no poller of its
// own). It also keeps the Monaco diff editor, where line selection (FR-REV-003, #581) plugs in.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import { ReviewsEvent, reviewsGet } from "../reviews/reviews-client";
import { ReviewsAnswer } from "../reviews/reviews-model";
import { TabActivity, whileShown } from "../tab-activity";
import {
    reviewCompare,
    ReviewFile,
    reviewFile,
    ReviewFileResult,
    reviewFiles,
    ReviewFilesResult,
    ReviewPrInfo,
    ReviewPrMetaKey,
    ReviewState,
    reviewState,
    ReviewWorktree,
    reviewWorktree,
    setReviewShown,
    setReviewViewed,
    subscribeReviewState,
} from "./review-client";
import { buildFileTree, firstFile, isViewed, MoltentermReviewView, treeFiles, TreeNode } from "./review-model";
import { getReviewSession, ReviewSessionInfo, startReviewSession, subscribeReviewSession } from "./review-session";

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

export type ReviewAiState = {
    open: boolean;
    status: "idle" | "starting" | "running" | "noagent" | "failed";
    message?: string;
    session?: ReviewSessionInfo;
};

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
    aiAtom = atom({ open: false, status: "idle" }) as PrimitiveAtom<ReviewAiState>;
    renderMsAtom = atom(null) as PrimitiveAtom<number>;

    treeAtom: Atom<TreeNode[]>;
    orderedFilesAtom: Atom<ReviewFile[]>;
    viewedCountAtom: Atom<number>;

    // The Monaco diff editor on screen (MonacoDiffViewer's onMount); FR-REV-003's selection reads it.
    diffEditor: MonacoTypes.editor.IStandaloneDiffEditor = null;
    started = false;
    cleanups: (() => void)[] = [];
    fileSeq = 0;
    // The base branch's tip as GitHub gave it with the head shown.
    baseOid: string = null;
    checkingHead = false;

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
        this.cleanups.push(
            subscribeReviewState(pr.repo, pr.number, (state) => globalStore.set(this.stateAtom, state)),
            subscribeReviewSession(pr.repo, pr.number, (update) => {
                if (update.ended) {
                    globalStore.set(this.aiAtom, (ai) => ({ ...ai, status: "idle", session: null }));
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
                globalStore.set(this.aiAtom, (ai) => ({ ...ai, open: true }));
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

    onDiffMount(diff: MonacoTypes.editor.IStandaloneDiffEditor, askedAt: number): () => void {
        this.diffEditor = diff;
        const sub = diff.onDidUpdateDiff(() => {
            sub.dispose();
            const ms = Math.round(performance.now() - askedAt);
            globalStore.set(this.renderMsAtom, ms);
            console.log(`[review] ${globalStore.get(this.selectedAtom)} rendered in ${ms} ms`);
        });
        return () => {
            sub.dispose();
            if (this.diffEditor === diff) {
                this.diffEditor = null;
            }
        };
    }

    applySession(session: ReviewSessionInfo) {
        const status = session.state === "failed" ? "failed" : session.state === "starting" ? "starting" : "running";
        globalStore.set(this.aiAtom, (ai) => ({ ...ai, status, session, message: session.message }));
    }

    // The AI panel (DS-REV-012): opening it starts the PR's review session (FR-REV-004), whose terminal wavesrv puts in
    // this tab; the session ends when the tab closes. The cards (#583 and after) show above it.
    async toggleAi() {
        const ai = globalStore.get(this.aiAtom);
        if (ai.open) {
            globalStore.set(this.aiAtom, { ...ai, open: false });
            return;
        }
        globalStore.set(this.aiAtom, { ...ai, open: true });
        if (ai.session == null && ai.status !== "starting") {
            await this.startSession();
        }
    }

    async startSession() {
        const pr = this.pr();
        globalStore.set(this.aiAtom, (ai) => ({ ...ai, status: "starting", message: null }));
        try {
            const result = await startReviewSession({
                tabid: globalStore.get(atoms.staticTabId),
                projectdir: pr.dir,
                repo: pr.repo,
                number: pr.number,
                title: pr.title,
                headref: pr.headref,
                headoid: globalStore.get(this.headAtom) ?? pr.headoid,
                baseref: pr.baseref,
            });
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

    dispose() {
        this.stop();
    }
}
