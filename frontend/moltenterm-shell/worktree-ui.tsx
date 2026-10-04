// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the worktree of a terminal shows (FR-SHELL-016): the pane header (with the link offer), the status bar and the
// tab tooltip; and the dialog that closing a linked terminal opens, the plan first. The tree comes from the status
// bar's probe (DS-SHELL-010): one cache in wavesrv, git at most once a second per tree.

import { globalStore } from "@/app/store/jotaiStore";
import { getWaveObjectAtom, loadAndPinWaveObject, makeORef } from "@/app/store/wos";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { cn, fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { paneStatus, usePaneStatus } from "./pane-status";
import { blockFolder, PaneBlockMeta } from "./status-bar-model";
import {
    ClosePlanView,
    closePlanView,
    readWorktreeDismissed,
    readWorktreeLink,
    tabTreesTooltip,
    TreeMarker,
    treeMarker,
    treeTooltipLine,
    worktreeOffer,
    WorktreePlan,
    worktreeRisk,
} from "./worktree-model";
import { dismissWorktree, linkWorktree, removeWorktree, unlinkWorktree, worktreePlan } from "./worktree-store";

const AccentButton =
    "cursor-pointer rounded bg-accent/80 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-accent";
const PlainButton =
    "cursor-pointer rounded border border-border px-3 py-1.5 text-xs text-secondary hover:bg-hover hover:text-primary";
const DangerButton =
    "cursor-pointer rounded bg-error/70 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-error";
const ChipButton = "cursor-pointer rounded px-1 hover:bg-hover hover:text-primary";

function blockPaneMeta(meta: MetaType): PaneBlockMeta {
    return { view: meta?.view, connection: meta?.connection, "cmd:cwd": meta?.["cmd:cwd"] };
}

export function WorktreeChip({
    marker,
    hideBranch,
    onClick,
    className,
}: {
    marker: TreeMarker;
    hideBranch?: boolean;
    onClick?: () => void;
    className?: string;
}) {
    if (marker == null) {
        return null;
    }
    const showBranch = !hideBranch && marker.branch !== "" && marker.kind === "worktree";
    return (
        <span
            className={cn(
                "inline-flex max-w-[14rem] min-w-[4.5rem] shrink-0 items-center gap-1 rounded border px-1.5 text-[11px] leading-[16px] whitespace-nowrap",
                marker.colorClass,
                marker.kind === "worktree" && !marker.linked && "border-dashed",
                onClick && "cursor-pointer",
                className
            )}
            title={marker.title}
            data-tree={marker.kind}
            onClick={onClick}
        >
            <i className={cn("fa fa-solid shrink-0 text-[9px]", `fa-${marker.icon}`)} />
            <span className="min-w-0 shrink-0 truncate">{marker.label}</span>
            {showBranch ? <span className="min-w-0 truncate opacity-80">· {marker.branch}</span> : null}
        </span>
    );
}

// The header part of a local terminal: its tree, and the link offer when its folder is in a worktree it is not linked
// to. With an agent label (#109) the branch is already shown there.
export function WorktreeHeaderLabel({ blockId, hideBranch }: { blockId: string; hideBranch?: boolean }) {
    const block = useAtomValue(getWaveObjectAtom<Block>(makeORef("block", blockId)));
    const meta = block?.meta;
    const folder = blockFolder(blockPaneMeta(meta));
    const link = readWorktreeLink(meta);
    const local =
        meta?.view === "term" && (meta?.connection == null || meta.connection === "" || meta.connection === "local");
    const probeDir = folder || (local && link.startsWith("/") ? link : "");
    const state = usePaneStatus(probeDir, folder ? blockId : null, link);
    const [busy, setBusy] = useState(false);
    if (!local || !probeDir) {
        return null;
    }
    const marker = treeMarker(state, link);
    const offer = worktreeOffer(state, link, readWorktreeDismissed(meta));
    const act = (fn: () => Promise<void>) =>
        fireAndForget(async () => {
            setBusy(true);
            try {
                await fn();
            } finally {
                setBusy(false);
            }
        });
    const offerName =
        offer
            .split("/")
            .filter((s) => s)
            .pop() ?? offer;
    return (
        <div className="flex shrink-0 items-center gap-1.5 pl-1 pr-1" data-role="molten-tree">
            <WorktreeChip
                marker={marker}
                hideBranch={hideBranch}
                onClick={marker?.kind === "missing" ? () => act(() => unlinkWorktree(blockId)) : undefined}
            />
            {offer ? (
                <span
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-accent/50 bg-accent/10 px-1.5 text-[11px] leading-[16px] text-secondary"
                    title={`This terminal is in the worktree ${offer}.\nLinked, the header shows it and closing the terminal offers to remove it.`}
                    data-role="molten-worktree-offer"
                >
                    <button
                        type="button"
                        disabled={busy}
                        className={cn(ChipButton, "text-accent")}
                        aria-label={`Link the worktree ${offerName} to this terminal`}
                        onClick={() => act(() => linkWorktree(blockId, offer))}
                    >
                        <i className="fa fa-solid fa-link mr-1 text-[9px]" />
                        Link
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        className={ChipButton}
                        title="Not now (not offered again for this worktree in this terminal)"
                        aria-label="Not now"
                        onClick={() => act(() => dismissWorktree(blockId, readWorktreeDismissed(meta), offer))}
                    >
                        <i className="fa fa-solid fa-xmark text-[9px]" />
                    </button>
                </span>
            ) : null}
        </div>
    );
}

// The tab tooltip lists the trees of its terminals. Read when the pointer enters the tab, through the same cache.
const TabTooltipMaxAgeMs = 5000;

export function useTabTreesTooltip(tabId: string): { title: string; onMouseEnter: () => void } {
    const [title, setTitle] = useState("");
    const readAt = useRef(0);
    const onMouseEnter = useCallback(() => {
        // Sweeping the pointer across the tabs reads each tab once every few seconds, not on every pass.
        if (Date.now() - readAt.current < TabTooltipMaxAgeMs) {
            return;
        }
        readAt.current = Date.now();
        fireAndForget(async () => {
            const tab = await loadAndPinWaveObject<Tab>(makeORef("tab", tabId));
            const blocks = await Promise.all(
                (tab?.blockids ?? []).map((id) => loadAndPinWaveObject<Block>(makeORef("block", id)))
            );
            const lines = await Promise.all(
                blocks.map(async (block) => {
                    const folder = blockFolder(blockPaneMeta(block?.meta));
                    const link = readWorktreeLink(block?.meta);
                    const dir = folder || (block?.meta?.view === "term" && link.startsWith("/") ? link : "");
                    if (!dir) {
                        return "";
                    }
                    try {
                        return treeTooltipLine(treeMarker(await paneStatus(dir, false, link), link));
                    } catch {
                        return "";
                    }
                })
            );
            setTitle(tabTreesTooltip(lines));
        });
    }, [tabId]);
    return { title, onMouseEnter };
}

// Closing a terminal linked to a worktree: the close is held until the dialog answers.
type CloseRequest = { blockId: string; path: string; close: () => void };

const CloseRequestAtom = atom(null) as PrimitiveAtom<CloseRequest>;
// Closes the dialog already answered: the next close of these blocks goes through.
const ApprovedCloses = new Set<string>();

export function interceptWorktreeClose(blockId: string, close: () => void): boolean {
    if (!blockId) {
        return false;
    }
    if (ApprovedCloses.delete(blockId)) {
        return false;
    }
    const block = globalStore.get(getWaveObjectAtom<Block>(makeORef("block", blockId)));
    const meta = block?.meta;
    const link = readWorktreeLink(meta);
    // The link names a local folder: a terminal switched to a remote connection has nothing of it to remove.
    const local = meta?.connection == null || meta.connection === "" || meta.connection === "local";
    if (meta?.view !== "term" || !link || !local) {
        return false;
    }
    if (globalStore.get(CloseRequestAtom) != null) {
        return true;
    }
    globalStore.set(CloseRequestAtom, { blockId, path: link, close });
    return true;
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
                <div className="max-h-24 overflow-auto rounded bg-black/20 px-2 py-1 font-mono text-[11px] text-muted">
                    {plan.changes.map((c) => (
                        <div key={c} className="truncate">
                            {c}
                        </div>
                    ))}
                    {plan.changecount > plan.changes.length ? <div>…</div> : null}
                </div>
            ) : null}
            <PlanLine text={view.unpushedLine} warn={plan.unpushed !== 0} />
            <PlanLine text={view.mergedLine} />
            <PlanLine text={view.ignoredLine} warn={plan.ignoredfilecount > 0} />
            <PlanLine text={view.terminalsLine} warn={view.shared} />
            <PlanLine text={view.blockedReason} warn />
        </div>
    );
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
    const lost = plan.changecount > 0 || plan.detached || plan.ignoredfilecount > 0;
    return (
        <div className="flex flex-col gap-1 text-warning">
            {plan.changecount > 0 ? (
                <div>{view.changesLine} will be deleted for good (git worktree remove --force).</div>
            ) : null}
            {plan.ignoredfilecount > 0 ? <div>{view.ignoredLine}.</div> : null}
            {plan.unpushed < 0 ? <div>{view.unpushedLine}: some commits may exist nowhere else.</div> : null}
            {plan.unpushed > 0 && plan.detached ? <div>{view.unpushedLine}.</div> : null}
            {plan.unpushed > 0 && !plan.detached ? (
                <div>
                    {view.unpushedLine}: they stay on {plan.branch}
                    {deleteBranch && view.canDeleteBranch ? ", deleted as asked (merged)" : ", which is kept"}.
                </div>
            ) : null}
            {view.shared ? <div>{view.terminalsLine}: its folder disappears from under them.</div> : null}
            {lost ? <div className="text-secondary">This cannot be undone.</div> : null}
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
    const block = useAtomValue(getWaveObjectAtom<Block>(makeORef("block", request.blockId)));
    const finish = (closeTerminal: boolean) => {
        onDone();
        // The terminal may have gone meanwhile (its shell exited, another window closed it): closing it again would
        // close whatever else is left in the tab.
        const stillHere = getLayoutModelForStaticTab()?.getNodeByBlockId(request.blockId) != null;
        if (closeTerminal && stillHere) {
            ApprovedCloses.add(request.blockId);
            request.close();
        }
    };
    useEffect(() => {
        if (block == null && step !== "working") {
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
                    finish(true);
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
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && step !== "working") {
                e.stopPropagation();
                e.preventDefault();
                finish(step === "done");
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    });
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
    const name = request.path
        .split("/")
        .filter((s) => s)
        .pop();
    let title = `Close the terminal of worktree ${name}?`;
    if (step === "confirm") {
        title =
            plan?.changecount > 0 || plan?.detached || plan?.ignoredfilecount > 0
                ? `Remove ${name} and lose what only it holds?`
                : `Remove ${name} anyway?`;
    } else if (step === "done") {
        title = `Worktree ${name} removed`;
    }
    return createPortal(
        <div
            className="fixed inset-0 z-[9600] flex items-center justify-center bg-black/40"
            data-role="molten-worktree-close"
        >
            <div className="flex w-[500px] max-w-[calc(100vw-32px)] flex-col rounded border border-border bg-modalbg shadow-xl">
                <div className="border-b border-border px-4 py-3">
                    <div className="text-sm font-semibold">{title}</div>
                    <div className="mt-0.5 truncate text-xs text-muted" title={request.path}>
                        {request.path}
                    </div>
                </div>
                <div className="flex flex-col gap-3 px-4 py-3 text-xs">
                    {plan == null && error == null ? <div className="text-muted">Reading the worktree…</div> : null}
                    {plan != null && (step === "plan" || step === "working") ? (
                        <PlanFacts plan={plan} view={view} />
                    ) : null}
                    {plan != null && step === "confirm" ? (
                        <ConfirmFacts plan={plan} view={view} deleteBranch={deleteBranch} />
                    ) : null}
                    {plan != null && step === "plan" && view.canDeleteBranch ? (
                        <label className="flex cursor-pointer items-center gap-2 text-secondary">
                            <input
                                type="checkbox"
                                checked={deleteBranch}
                                onChange={(e) => setDeleteBranch(e.target.checked)}
                            />
                            Also delete the branch {plan.branch} (merged)
                        </label>
                    ) : null}
                    {notice ? <div className="text-secondary">{notice}</div> : null}
                    {error ? <div className="text-error">{error}</div> : null}
                </div>
                <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                    {step === "done" ? (
                        <button type="button" autoFocus className={AccentButton} onClick={() => finish(true)}>
                            Close the terminal
                        </button>
                    ) : null}
                    {step === "confirm" ? (
                        <>
                            <button type="button" className={PlainButton} onClick={() => setStep("plan")}>
                                Back
                            </button>
                            <button type="button" className={DangerButton} onClick={() => remove(true)}>
                                Remove anyway
                            </button>
                        </>
                    ) : null}
                    {(step === "plan" || step === "working") && (plan != null || error != null) ? (
                        <>
                            <button
                                type="button"
                                disabled={step === "working"}
                                className={PlainButton}
                                onClick={() => finish(false)}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                disabled={step === "working"}
                                autoFocus={view?.defaultChoice !== "remove"}
                                className={view?.defaultChoice === "remove" ? PlainButton : AccentButton}
                                onClick={() => finish(true)}
                            >
                                Keep the worktree
                            </button>
                            {view?.canRemove ? (
                                <button
                                    type="button"
                                    disabled={step === "working"}
                                    autoFocus={view.defaultChoice === "remove"}
                                    className={view.defaultChoice === "remove" ? AccentButton : PlainButton}
                                    onClick={onRemove}
                                >
                                    {step === "working" ? "Removing…" : "Remove the worktree"}
                                </button>
                            ) : null}
                        </>
                    ) : null}
                </div>
            </div>
        </div>,
        document.body
    );
}

export function WorktreeCloseHost() {
    const request = useAtomValue(CloseRequestAtom);
    if (request == null) {
        return null;
    }
    return (
        <WorktreeCloseDialog
            key={request.blockId}
            request={request}
            onDone={() => globalStore.set(CloseRequestAtom, null)}
        />
    );
}
