// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The close guard of the window's terminals. Closing what a worktree is linked to (FR-SHELL-016, #114, #134): every
// close of a terminal linked to a worktree shows its plan first (remove, keep or cancel); closing a whole tab shows one
// grouped dialog, one row per worktree, Keep selected; a terminal that went without a window asking (cmd:closeonexit)
// left a notification whose action opens the same dialog without the terminal. wavesrv re-reads every plan before
// removing anything. Closing what runs (FR-SHELL-061, #489): the same closes read what they would stop first, and ask
// in one dialog, the worktree dialog when a worktree is linked too (busy-close.tsx).

import { globalStore } from "@/app/store/jotaiStore";
import { getWaveObjectAtom, loadAndPinWaveObject, makeORef } from "@/app/store/wos";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { cn, fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { BusyCloseHost, DangerButton as BusyDangerButton, RunningList } from "./busy-close";
import { listenMainBusyAsks } from "./busy-close-main";
import { BusyCloseAction, RunningItem } from "./busy-close-model";
import {
    askBusyClose,
    busyCloseEnabled,
    busyDialogOpen,
    closingTerminalOf,
    isTerminalMeta,
    readRunning,
} from "./busy-close-store";
import { DialogFrame, useEscape } from "./dialog-frame";
import { MoltenWave } from "./molten-button";
import { registerNotificationGesture } from "./notifications-store";
import {
    ClosePlanView,
    closePlanView,
    closingWorktreeLink,
    makeTabCloseRows,
    mergeTabCloseRows,
    readReviewPath,
    tabCloseRemovals,
    TabCloseRow,
    tabWorktrees,
    WorktreePlan,
    WorktreeReviewGesture,
    worktreeRisk,
} from "./worktree-model";
import { removeWorktree, resolveKeptWorktreeNotice, worktreePlan } from "./worktree-store";

const AccentButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";
const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";
const DangerButton = BusyDangerButton;
const RunningHeading = "Closing stops:";

function pathName(path: string): string {
    return (
        path
            .split("/")
            .filter((s) => s)
            .pop() ?? path
    );
}

// Closing a terminal linked to a worktree: the close is held until the dialog answers. Without a terminal
// (standalone), the dialog reviews a worktree a notification names. running: what the close would stop.
type CloseRequest = {
    blockId: string;
    path: string;
    close: () => void;
    standalone?: boolean;
    running?: RunningItem[];
    action?: BusyCloseAction;
};

// A tab close waits on its grouped dialog: "cancel" keeps the tab, "asked" closes it (the dialog was the
// confirmation), "nothing" closes it as if no worktree were linked (every worktree was already gone).
type TabCloseAnswer = "cancel" | "asked" | "nothing";
type TabCloseRequest = {
    tabId: string;
    rows: TabCloseRow[];
    blockIds: string[];
    running?: RunningItem[];
    answer: (a: TabCloseAnswer) => void;
};

const CloseRequestAtom = atom(null) as PrimitiveAtom<CloseRequest>;
const NoBlockAtom = atom(null) as PrimitiveAtom<Block>;
const TabCloseRequestAtom = atom(null) as PrimitiveAtom<TabCloseRequest>;
// Closes the dialog already answered: the next close of these blocks goes through.
const ApprovedCloses = new Set<string>();
// Terminals whose close was answered a moment ago: closing the last terminal of a tab closes the tab, which must not ask
// about it again.
const AnsweredCloses = new Map<string, number>();
const AnsweredCloseWindowMs = 30000;

function markAnswered(blockId: string): void {
    const now = Date.now();
    for (const [id, at] of AnsweredCloses) {
        if (now - at > AnsweredCloseWindowMs) {
            AnsweredCloses.delete(id);
        }
    }
    AnsweredCloses.set(blockId, now);
}

function answeredRecently(blockId: string): boolean {
    const at = AnsweredCloses.get(blockId);
    return at != null && Date.now() - at <= AnsweredCloseWindowMs;
}

// Closes whose terminals are being read: pressing the same close again meanwhile does nothing more.
const PendingCloses = new Set<string>();

export function dialogOpen(): boolean {
    return (
        globalStore.get(CloseRequestAtom) != null || globalStore.get(TabCloseRequestAtom) != null || busyDialogOpen()
    );
}

// The block is still in this window's layout, tiled or ephemeral.
function blockInLayout(blockId: string): boolean {
    const layoutModel = getLayoutModelForStaticTab();
    if (layoutModel == null) {
        return false;
    }
    if (layoutModel.getNodeByBlockId(blockId) != null) {
        return true;
    }
    return globalStore.get(layoutModel.ephemeralNode)?.data?.blockId === blockId;
}

// The close itself, once nothing is left to ask. The terminal may have gone meanwhile (its shell exited, another
// window closed it): closing it again would close whatever else is left in the tab.
function closeApproved(blockId: string, close: () => void): void {
    if (!blockInLayout(blockId)) {
        return;
    }
    ApprovedCloses.add(blockId);
    close();
}

// One dialog for what runs, then the close (FR-SHELL-061); nothing running closes at once.
async function closeAskingRunning(
    blockId: string,
    close: () => void,
    action: BusyCloseAction,
    running: RunningItem[]
): Promise<void> {
    if (running == null || running.length === 0) {
        closeApproved(blockId, close);
        return;
    }
    if (dialogOpen()) {
        return;
    }
    if (!(await askBusyClose({ action, running, blockId }))) {
        return;
    }
    markAnswered(blockId);
    closeApproved(blockId, close);
}

// Every close of a single terminal comes here first (Cmd+W, the header's close and menu, the command panel's Close,
// Ctrl+Shift+X, an ephemeral pane's backdrop). false: nothing to ask, the caller closes now. true: the close is held
// (what runs is being read, a dialog shows, or another close dialog is open); close runs once it is answered and must
// come back here, where the answer lets it through.
export function interceptTerminalClose(blockId: string, close: () => void, action: BusyCloseAction = "pane"): boolean {
    if (!blockId) {
        return false;
    }
    if (ApprovedCloses.delete(blockId)) {
        return false;
    }
    const block = globalStore.get(getWaveObjectAtom<Block>(makeORef("block", blockId)));
    const link = closingWorktreeLink(block?.meta);
    const check = isTerminalMeta(block?.meta) && busyCloseEnabled();
    if (!link && !check) {
        return false;
    }
    if (dialogOpen() || PendingCloses.has(blockId)) {
        return true;
    }
    PendingCloses.add(blockId);
    fireAndForget(async () => {
        let running: RunningItem[] = [];
        try {
            running = check ? await readRunning([closingTerminalOf(block)]) : [];
        } finally {
            PendingCloses.delete(blockId);
        }
        if (!link) {
            await closeAskingRunning(blockId, close, action, running);
            return;
        }
        if (dialogOpen()) {
            return;
        }
        globalStore.set(CloseRequestAtom, { blockId, path: link, close, running, action });
    });
    return true;
}

type CloseTabFn = (workspaceId: string, tabId: string, confirmClose: boolean) => Promise<boolean>;

// Every close of a whole tab comes here (the tab's × and its hold, its menu, middle-click, Cmd+Shift+W, the vertical
// tab bar, the last terminal's close), in place of Electron's closeTab: one read of what its terminals run and of the
// worktrees they are linked to, then one dialog at most. A dialog answered for it is the confirmation, so Electron's own
// (tab:confirmclose) does not follow.
export async function closeTabAskingFirst(
    closeTab: CloseTabFn,
    workspaceId: string,
    tabId: string,
    confirmClose: boolean
): Promise<boolean> {
    if (dialogOpen()) {
        return false;
    }
    let blocks: Block[] = [];
    try {
        const tab = await loadAndPinWaveObject<Tab>(makeORef("tab", tabId));
        blocks = await Promise.all(
            (tab?.blockids ?? []).map((id) => loadAndPinWaveObject<Block>(makeORef("block", id)))
        );
    } catch (e) {
        console.log("terminals of the tab being closed", e);
    }
    const present = blocks.filter((b) => b != null);
    const worktrees = tabWorktrees(present, answeredRecently);
    const running = busyCloseEnabled()
        ? await readRunning(present.filter((b) => !answeredRecently(b.oid)).map(closingTerminalOf))
        : [];
    // The close of its last terminal was answered a moment ago: that answer was the confirmation.
    const ownConfirm = present.some((b) => answeredRecently(b.oid)) ? false : confirmClose;
    if (worktrees.length === 0 && running.length === 0) {
        return closeTab(workspaceId, tabId, ownConfirm);
    }
    if (dialogOpen()) {
        return false;
    }
    const tabName = running.find((r) => !!r.tab)?.tab;
    if (worktrees.length === 0) {
        if (!(await askBusyClose({ action: "tab", running, tabId, tabName }))) {
            return false;
        }
        return closeTab(workspaceId, tabId, false);
    }
    const answer = await new Promise<TabCloseAnswer>((resolve) => {
        globalStore.set(TabCloseRequestAtom, {
            tabId,
            rows: makeTabCloseRows(worktrees),
            blockIds: present.map((b) => b.oid),
            running,
            answer: resolve,
        });
    });
    if (answer === "cancel") {
        return false;
    }
    // Every worktree was already gone, so the dialog never asked: what runs still has to.
    if (answer === "nothing" && running.length > 0) {
        if (!(await askBusyClose({ action: "tab", running, tabId, tabName }))) {
            return false;
        }
        return closeTab(workspaceId, tabId, false);
    }
    return closeTab(workspaceId, tabId, answer === "nothing" ? ownConfirm : false);
}

function PlanLine({ text, warn }: { text: string; warn?: boolean }) {
    if (!text) {
        return null;
    }
    return <div className={cn("text-secondary", warn && "text-warning")}>{text}</div>;
}

function PlanFacts({ plan, view }: { plan: WorktreePlan; view: ClosePlanView }) {
    return (
        <div className="flex flex-col gap-1">
            <PlanLine text={view.branchLine ? `Branch ${view.branchLine}` : "No branch"} />
            <PlanLine text={view.changesLine} warn={plan.changecount > 0} />
            {plan.changes.length > 0 ? (
                <div className="max-h-24 overflow-auto rounded-4 bg-black/20 px-2 py-1 font-mono text-11 text-muted">
                    {plan.changes.map((c) => (
                        <div key={c} className="truncate">
                            {c}
                        </div>
                    ))}
                    {plan.changecount > plan.changes.length ? <div>…</div> : null}
                </div>
            ) : null}
            <PlanLine text={view.unpushedLine} warn={view.unpushedAtRisk} />
            <PlanLine text={view.mergedLine} />
            <PlanLine text={view.ignoredLine} warn={plan.ignoredfilecount > 0} />
            <PlanLine text={view.terminalsLine} warn={view.shared} />
            <PlanLine text={view.blockedReason} warn />
        </div>
    );
}

function lostForGood(plan: WorktreePlan): boolean {
    return plan.changecount > 0 || plan.detached || plan.ignoredfilecount > 0;
}

function ConfirmFacts({
    plan,
    view,
    deleteBranch,
}: {
    plan: WorktreePlan;
    view: ClosePlanView;
    deleteBranch: boolean;
}) {
    return (
        <div className="flex flex-col gap-1 text-warning">
            {plan.changecount > 0 ? (
                <div>{view.changesLine} will be deleted for good (git worktree remove --force).</div>
            ) : null}
            {plan.ignoredfilecount > 0 ? <div>{view.ignoredLine}.</div> : null}
            {plan.unpushed < 0 ? <div>{view.unpushedLine}: some commits may exist nowhere else.</div> : null}
            {plan.unpushed > 0 && plan.detached ? <div>{view.unpushedLine}.</div> : null}
            {plan.unpushed > 0 && !plan.detached && view.unpushedAtRisk ? (
                <div>
                    {view.unpushedLine}: they stay on {plan.branch}
                    {deleteBranch && view.canDeleteBranch ? ", deleted as asked (merged)" : ", which is kept"}.
                </div>
            ) : null}
            {view.shared ? <div>{view.terminalsLine}: its folder disappears from under them.</div> : null}
            {lostForGood(plan) ? <div className="text-secondary">This cannot be undone.</div> : null}
        </div>
    );
}

type DialogStep = "plan" | "confirm" | "working" | "done";

function WorktreeCloseDialog({ request, onDone }: { request: CloseRequest; onDone: () => void }) {
    const [plan, setPlan] = useState<WorktreePlan>(null);
    const [error, setError] = useState<string>(null);
    const [step, setStep] = useState<DialogStep>("plan");
    const [deleteBranch, setDeleteBranch] = useState(false);
    const [notice, setNotice] = useState<string>(null);
    const block = useAtomValue(
        request.blockId ? getWaveObjectAtom<Block>(makeORef("block", request.blockId)) : NoBlockAtom
    );
    const standalone = !!request.standalone;
    const running = request.running ?? [];
    const busy = running.length > 0;
    const finish = (closeTerminal: boolean) => {
        onDone();
        if (standalone) {
            return;
        }
        if (closeTerminal) {
            markAnswered(request.blockId);
            closeApproved(request.blockId, request.close);
        }
    };
    useEffect(() => {
        if (!standalone && block == null && step !== "working") {
            onDone();
        }
    }, [block == null]);
    useEffect(() => {
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const next = await worktreePlan(request.path, request.blockId);
                if (cancelled) {
                    return;
                }
                // Removed outside MoltenTerm: nothing to decide.
                if (next.missing) {
                    resolveKeptWorktreeNotice(request.path, next.real);
                    // Nothing to decide for the worktree, but what runs in the terminal still asks.
                    if (!standalone && busy) {
                        onDone();
                        fireAndForget(() =>
                            closeAskingRunning(request.blockId, request.close, request.action ?? "pane", running)
                        );
                        return;
                    }
                    if (!standalone) {
                        finish(true);
                        return;
                    }
                    setNotice("This worktree is no longer on disk: nothing to remove.");
                    setStep("done");
                    return;
                }
                setPlan(next);
            } catch (e) {
                if (!cancelled) {
                    setError(String(e?.message ?? e));
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [request.path, request.blockId]);
    useEscape(step !== "working", () => finish(step === "done"));
    const view = plan ? closePlanView(plan) : null;
    const remove = (confirmed: boolean) =>
        fireAndForget(async () => {
            setStep("working");
            setError(null);
            try {
                const result = await removeWorktree(request.path, request.blockId, {
                    confirmed: confirmed ? worktreeRisk(plan) : null,
                    deleteBranch: deleteBranch && view?.canDeleteBranch,
                });
                if (deleteBranch && result.branchkept) {
                    setNotice(`Worktree removed; the branch ${plan.branch} is kept: ${result.branchkept}.`);
                    setStep("done");
                    return;
                }
                finish(true);
            } catch (e) {
                setError(String(e?.message ?? e));
                setStep("plan");
            }
        });
    const onRemove = () => {
        if (view.atRisk) {
            setStep("confirm");
            return;
        }
        remove(false);
    };
    const name = pathName(request.path);
    let title = standalone ? `Remove the worktree ${name}?` : `Close the terminal of worktree ${name}?`;
    if (step === "confirm") {
        title =
            plan != null && lostForGood(plan)
                ? `Remove ${name} and lose what only it holds?`
                : `Remove ${name} anyway?`;
    } else if (step === "done") {
        title = plan != null ? `Worktree ${name} removed` : `Worktree ${name}`;
    }
    const buttons = (
        <>
            {step === "done" ? (
                <button type="button" autoFocus className={AccentButton} onClick={() => finish(true)}>
                    {standalone ? "Close" : "Close the terminal"}
                    <MoltenWave />
                </button>
            ) : null}
            {step === "confirm" ? (
                <>
                    <button type="button" className={PlainButton} onClick={() => setStep("plan")}>
                        Back
                    </button>
                    <button type="button" className={DangerButton} onClick={() => remove(true)}>
                        Remove anyway
                        <MoltenWave />
                    </button>
                </>
            ) : null}
            {(step === "plan" || step === "working") && (plan != null || error != null) ? (
                <>
                    {standalone ? null : (
                        <button
                            type="button"
                            disabled={step === "working"}
                            autoFocus={busy}
                            className={PlainButton}
                            onClick={() => finish(false)}
                        >
                            Cancel
                        </button>
                    )}
                    {/* While something runs, both answers stop it: Cancel takes the focus and they read as destructive. */}
                    <button
                        type="button"
                        disabled={step === "working"}
                        autoFocus={!busy && (standalone || view?.defaultChoice !== "remove")}
                        className={
                            busy
                                ? DangerButton
                                : !standalone && view?.defaultChoice === "remove"
                                  ? PlainButton
                                  : AccentButton
                        }
                        onClick={() => finish(true)}
                    >
                        Keep the worktree
                        <MoltenWave />
                    </button>
                    {view?.canRemove ? (
                        <button
                            type="button"
                            disabled={step === "working"}
                            autoFocus={!busy && !standalone && view.defaultChoice === "remove"}
                            className={
                                busy
                                    ? DangerButton
                                    : !standalone && view.defaultChoice === "remove"
                                      ? AccentButton
                                      : PlainButton
                            }
                            onClick={onRemove}
                        >
                            {step === "working" ? "Removing…" : "Remove the worktree"}
                            <MoltenWave />
                        </button>
                    ) : null}
                </>
            ) : null}
        </>
    );
    return (
        <DialogFrame role="molten-worktree-close" title={title} subtitle={request.path} buttons={buttons}>
            {standalone && step === "plan" ? (
                <div className="text-muted">Its terminal is closed; the worktree is still on disk.</div>
            ) : null}
            {step === "plan" || step === "working" ? <RunningList items={running} heading={RunningHeading} /> : null}
            {plan == null && error == null && notice == null ? (
                <div className="text-muted">Reading the worktree…</div>
            ) : null}
            {plan != null && (step === "plan" || step === "working") ? <PlanFacts plan={plan} view={view} /> : null}
            {plan != null && step === "confirm" ? (
                <ConfirmFacts plan={plan} view={view} deleteBranch={deleteBranch} />
            ) : null}
            {plan != null && step === "plan" && view.canDeleteBranch ? (
                <label className="flex cursor-pointer items-center gap-2 text-secondary">
                    <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
                    Also delete the branch {plan.branch} (merged)
                </label>
            ) : null}
            {notice ? <div className="text-secondary">{notice}</div> : null}
            {error ? <div className="text-error">{error}</div> : null}
        </DialogFrame>
    );
}

function TabCloseRowView({
    row,
    disabled,
    onChange,
}: {
    row: TabCloseRow;
    disabled: boolean;
    onChange: (next: Partial<TabCloseRow>) => void;
}) {
    const view = row.plan ? closePlanView(row.plan) : null;
    const name = pathName(row.path);
    return (
        <div className="flex flex-col gap-2 rounded-4 border border-border px-3 py-2" data-role="molten-worktree-row">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate font-semibold text-primary">{name}</div>
                    <div className="truncate text-11 text-muted" title={row.path}>
                        {row.path}
                    </div>
                </div>
                {row.removed ? (
                    <div className="shrink-0 text-secondary">removed</div>
                ) : (
                    <div className="flex shrink-0 items-center gap-3">
                        <label className="flex cursor-pointer items-center gap-1 text-secondary">
                            <input
                                type="radio"
                                name={`wt-${row.path}`}
                                disabled={disabled}
                                checked={row.choice === "keep"}
                                onChange={() => onChange({ choice: "keep", deleteBranch: false })}
                            />
                            Keep
                        </label>
                        {view?.canRemove ? (
                            <label className="flex cursor-pointer items-center gap-1 text-secondary">
                                <input
                                    type="radio"
                                    name={`wt-${row.path}`}
                                    disabled={disabled}
                                    checked={row.choice === "remove"}
                                    onChange={() => onChange({ choice: "remove" })}
                                />
                                Remove
                            </label>
                        ) : null}
                    </div>
                )}
            </div>
            {row.plan == null && row.error == null ? <div className="text-muted">Reading the worktree…</div> : null}
            {row.plan != null && !row.removed ? <PlanFacts plan={row.plan} view={view} /> : null}
            {row.plan != null && !row.removed && row.choice === "remove" && view.canDeleteBranch ? (
                <label className="flex cursor-pointer items-center gap-2 text-secondary">
                    <input
                        type="checkbox"
                        disabled={disabled}
                        checked={row.deleteBranch}
                        onChange={(e) => onChange({ deleteBranch: e.target.checked })}
                    />
                    Also delete the branch {row.plan.branch} (merged)
                </label>
            ) : null}
            {row.error ? <div className="text-error">{row.error}</div> : null}
        </div>
    );
}

type TabDialogStep = "plan" | "confirm" | "working";

function TabCloseDialog({ request, onDone }: { request: TabCloseRequest; onDone: () => void }) {
    const [rows, setRows] = useState<TabCloseRow[]>(request.rows);
    const [step, setStep] = useState<TabDialogStep>("plan");
    const tab = useAtomValue(getWaveObjectAtom<Tab>(makeORef("tab", request.tabId)));
    const running = request.running ?? [];
    const busy = running.length > 0;
    const answer = (a: TabCloseAnswer) => {
        onDone();
        request.answer(a);
    };
    const updateRow = (path: string, next: Partial<TabCloseRow>) =>
        setRows((current) => current.map((r) => (r.path === path ? { ...r, ...next } : r)));
    // The tab went meanwhile (another window closed it, its last shell exited): nothing left to close here.
    useEffect(() => {
        if (tab == null && step !== "working") {
            answer("cancel");
        }
    }, [tab == null]);
    useEffect(() => {
        let cancelled = false;
        fireAndForget(async () => {
            const plans = await Promise.all(
                request.rows.map(async (row) => {
                    try {
                        return { plan: await worktreePlan(row.path, "", request.blockIds), error: null as string };
                    } catch (e) {
                        return { plan: null as WorktreePlan, error: String(e?.message ?? e) };
                    }
                })
            );
            if (cancelled) {
                return;
            }
            const next: TabCloseRow[] = [];
            plans.forEach((p, i) => {
                // Removed outside MoltenTerm: nothing to decide for it.
                if (p.plan?.missing) {
                    resolveKeptWorktreeNotice(request.rows[i].path, p.plan.real);
                    return;
                }
                next.push({ ...request.rows[i], plan: p.plan, error: p.error });
            });
            if (next.length === 0) {
                answer("nothing");
                return;
            }
            setRows(mergeTabCloseRows(next));
        });
        return () => {
            cancelled = true;
        };
    }, [request]);
    useEscape(step !== "working", () => (step === "confirm" ? setStep("plan") : answer("cancel")));
    const { remove, atRisk } = tabCloseRemovals(rows);
    const loading = rows.some((r) => r.plan == null && r.error == null);
    const runRemovals = () =>
        fireAndForget(async () => {
            setStep("working");
            let failed = false;
            for (const row of remove) {
                const confirmed = closePlanView(row.plan).atRisk ? worktreeRisk(row.plan) : null;
                try {
                    await removeWorktree(row.path, "", {
                        confirmed,
                        deleteBranch: row.deleteBranch && closePlanView(row.plan).canDeleteBranch,
                        blockIds: request.blockIds,
                    });
                    updateRow(row.path, { removed: true, error: null });
                } catch (e) {
                    failed = true;
                    updateRow(row.path, { error: String(e?.message ?? e) });
                }
            }
            if (failed) {
                setStep("plan");
                return;
            }
            answer("asked");
        });
    const onClose = () => {
        if (atRisk.length > 0) {
            setStep("confirm");
            return;
        }
        runRemovals();
    };
    const count = rows.length;
    let title = `Close a tab with ${count === 1 ? "a worktree" : `${count} worktrees`}?`;
    if (step === "confirm") {
        title = atRisk.some((r) => lostForGood(r.plan))
            ? "Remove and lose what only these worktrees hold?"
            : "Remove these worktrees anyway?";
    }
    const closeLabel = remove.length > 0 ? `Remove ${remove.length} and close the tab` : "Close the tab";
    const buttons =
        step === "confirm" ? (
            <>
                <button type="button" className={PlainButton} onClick={() => setStep("plan")}>
                    Back
                </button>
                <button type="button" className={DangerButton} onClick={runRemovals}>
                    Remove anyway and close the tab
                    <MoltenWave />
                </button>
            </>
        ) : (
            <>
                <button
                    type="button"
                    autoFocus={busy}
                    disabled={step === "working"}
                    className={PlainButton}
                    onClick={() => answer("cancel")}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    autoFocus={!busy}
                    disabled={step === "working" || loading}
                    className={remove.length > 0 || busy ? DangerButton : AccentButton}
                    onClick={onClose}
                >
                    {step === "working" ? "Removing…" : closeLabel}
                    <MoltenWave />
                </button>
            </>
        );
    return (
        <DialogFrame
            role="molten-worktree-tab-close"
            title={title}
            subtitle={step === "confirm" ? null : "Every worktree is kept unless you choose Remove."}
            wide
            buttons={buttons}
        >
            {step === "confirm" ? null : <RunningList items={running} heading={RunningHeading} />}
            {step === "confirm"
                ? atRisk.map((row) => (
                      <div key={row.path} className="flex flex-col gap-1" data-role="molten-worktree-confirm">
                          <div className="font-semibold text-primary">{pathName(row.path)}</div>
                          <ConfirmFacts
                              plan={row.plan}
                              view={closePlanView(row.plan)}
                              deleteBranch={row.deleteBranch}
                          />
                      </div>
                  ))
                : rows.map((row) => (
                      <TabCloseRowView
                          key={row.path}
                          row={row}
                          disabled={step === "working"}
                          onChange={(next) => updateRow(row.path, next)}
                      />
                  ))}
        </DialogFrame>
    );
}

// A notification's "Review and remove…": the plan dialog for a worktree whose terminal is gone.
async function reviewKeptWorktree(args: Record<string, any>) {
    const path = readReviewPath(args);
    if (!path) {
        return { ok: false, error: "no worktree to review" };
    }
    if (dialogOpen()) {
        return { ok: false, error: "another worktree dialog is open" };
    }
    globalStore.set(CloseRequestAtom, { blockId: "", path, close: () => {}, standalone: true });
    return { ok: true };
}

// The close dialogs of this window: the worktree ones and the one for what runs (only one is ever open).
export function WorktreeCloseHost() {
    const request = useAtomValue(CloseRequestAtom);
    const tabRequest = useAtomValue(TabCloseRequestAtom);
    useEffect(() => registerNotificationGesture(WorktreeReviewGesture, reviewKeptWorktree), []);
    // Electron main's asks (window close, quit, workspace delete, switch: FR-SHELL-062) wait while one of these is open.
    useEffect(() => listenMainBusyAsks(dialogOpen), []);
    if (tabRequest != null) {
        return (
            <TabCloseDialog
                key={tabRequest.tabId}
                request={tabRequest}
                onDone={() => globalStore.set(TabCloseRequestAtom, null)}
            />
        );
    }
    if (request == null) {
        return <BusyCloseHost />;
    }
    return (
        <WorktreeCloseDialog
            key={`${request.blockId}:${request.path}`}
            request={request}
            onDone={() => globalStore.set(CloseRequestAtom, null)}
        />
    );
}
