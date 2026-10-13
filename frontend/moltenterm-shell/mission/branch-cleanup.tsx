// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Branch cleaning from the Project header (FR-MC-017), as Notulia's BranchCleanupDialog: the plan first, what would go
// and what stays with why, then nothing leaves without a click on the delete button. wavesrv checks each branch again
// before deleting it: the plan shown is not trusted blindly.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ScrimClass } from "../dialog-frame";
import { MoltenWave } from "../molten-button";
import { ActionSecondaryClass } from "./action-button";
import {
    branchesAutoDelete,
    branchesClean,
    BranchesCleanResult,
    branchesPlan,
    BranchesPlan,
    BranchKeepReason,
    BranchPlan,
} from "./mission-client";

const KeepReasons: Record<Exclude<BranchKeepReason, "commits-after-pr">, string> = {
    protected: "a main branch",
    "not-on-trunk": "its code is not on the trunk yet",
    "content-unknown": "git could not compare its content",
    "checked-out": "open in a worktree",
    "open-pr": "a pull request is open",
    "pr-unknown": "GitHub did not say whether it has a pull request",
};

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";

export function branchLabel(b: BranchPlan): string {
    return b.remote ? `origin/${b.name}` : b.name;
}

// Why a branch goes or stays, as the list shows it next to the branch (#571).
export function branchReason(b: BranchPlan, trunk: string): string {
    switch (b.reason) {
        case "merged-pr":
            return `merged in #${b.pr}`;
        case "on-trunk":
            return `its code is on ${trunk}`;
        case "patches-on-trunk":
            return `its commits are on ${trunk} under new ids`;
        case "commits-after-pr":
            return `commits after #${b.pr} was merged`;
    }
    return KeepReasons[b.reason as keyof typeof KeepReasons] ?? b.reason ?? "";
}

export function cleanResultLine(result: BranchesCleanResult): string {
    return `${result.deleted.length} branch(es) deleted${result.failed ? `, ${result.failed} failed` : ""}.`;
}

function BranchCleanupDialog({ dir, onClose, onCleaned }: { dir: string; onClose: () => void; onCleaned: () => void }) {
    const [plan, setPlan] = useState<BranchesPlan>(null);
    const [error, setError] = useState<string>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<BranchesCleanResult>(null);
    // null while the offer is unanswered in this dialog, then "on" or "later".
    const [offerAnswer, setOfferAnswer] = useState<"on" | "later">(null);
    const [offerBusy, setOfferBusy] = useState(false);
    useEffect(() => {
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const next = await branchesPlan(dir);
                if (!cancelled) {
                    setPlan(next);
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
    }, [dir]);
    const going = (plan?.branches ?? []).filter((b) => b.action === "delete");
    const staying = (plan?.branches ?? []).filter((b) => b.action === "keep");
    const trunk = plan?.trunk || "the trunk";
    const answerOffer = (enable: boolean) =>
        fireAndForget(async () => {
            setOfferBusy(true);
            setError(null);
            try {
                await branchesAutoDelete(dir, enable);
                setOfferAnswer(enable ? "on" : "later");
            } catch (e) {
                setError(String(e?.message ?? e));
            } finally {
                setOfferBusy(false);
            }
        });
    const clean = () =>
        fireAndForget(async () => {
            setBusy(true);
            setError(null);
            try {
                setResult(await branchesClean(dir, [...new Set(going.map((b) => b.name))]));
                onCleaned();
            } catch (e) {
                setError(String(e?.message ?? e));
            } finally {
                setBusy(false);
            }
        });
    return createPortal(
        <div
            className={cn("fixed inset-0 z-[9600] flex items-center justify-center", ScrimClass)}
            onPointerDown={onClose}
        >
            <div
                onPointerDown={(e) => e.stopPropagation()}
                className="flex max-h-[80vh] w-[620px] max-w-[calc(100vw-32px)] flex-col rounded-10 border border-border bg-surface-3 shadow-e3"
                data-testid="branch-cleanup"
            >
                <div className="border-b border-border px-4 py-3">
                    <div className="text-13 leading-5 font-semibold">Clean branches</div>
                    <div className="mt-0.5 text-12 text-muted">
                        Branches whose pull request was merged go, and so do those whose code is already on {trunk}. The
                        main branches stay, and so does anything in doubt.
                    </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-12">
                    {error ? (
                        <div className="mb-2 rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-error">
                            {error}
                        </div>
                    ) : null}
                    {plan == null && error == null ? (
                        <div className="flex items-center gap-2 text-muted">
                            <i className="fa fa-solid fa-circle-notch fa-spin mt-step-spin text-11" />
                            Comparing each branch with {trunk}…
                        </div>
                    ) : null}
                    {result ? (
                        <div className="flex flex-col gap-1">
                            <p className="text-13 leading-5 text-primary" data-testid="cleanup-result">
                                {cleanResultLine(result)}
                            </p>
                            {(result.errors ?? []).map((e) => (
                                <p key={e} className="text-muted">
                                    {e}
                                </p>
                            ))}
                        </div>
                    ) : plan ? (
                        <div className="flex flex-col gap-4">
                            {plan.autodeleteoffer && offerAnswer !== "later" ? (
                                <AutoDeleteOffer done={offerAnswer === "on"} busy={offerBusy} onAnswer={answerOffer} />
                            ) : null}
                            <div>
                                <div className="mb-1.5 font-medium text-muted">Would go ({going.length})</div>
                                {going.length === 0 ? <p className="text-muted">Nothing to clean.</p> : null}
                                {going.map((b) => (
                                    <div key={branchLabel(b)} className="flex items-center gap-2 py-0.5">
                                        <i className="fa fa-solid fa-trash-can w-3.5 text-11 text-error" />
                                        <code>{branchLabel(b)}</code>
                                        {b.reason ? (
                                            <span className="text-muted">— {branchReason(b, trunk)}</span>
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                            <div>
                                <div className="mb-1.5 font-medium text-muted">Stay ({staying.length})</div>
                                {staying.map((b) => (
                                    <div key={branchLabel(b)} className="flex items-center gap-2 py-0.5">
                                        <i className="fa fa-solid fa-code-branch w-3.5 text-11 text-muted" />
                                        <code>{branchLabel(b)}</code>
                                        <span className="text-muted">— {branchReason(b, trunk)}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : null}
                </div>
                <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
                    <button type="button" onClick={onClose} className={PlainButton}>
                        {result ? "Close" : "Cancel"}
                    </button>
                    {!result ? (
                        <button
                            type="button"
                            disabled={busy || going.length === 0}
                            onClick={clean}
                            className={cn(
                                "flex cursor-pointer items-center gap-1.5 rounded-6 border border-error/60 bg-error/15 px-3 py-1 text-12 text-error transition-colors duration-120 ease-mt hover:bg-error/25 disabled:cursor-default disabled:opacity-50"
                            )}
                        >
                            {busy ? (
                                <i className="fa fa-solid fa-circle-notch fa-spin mt-step-spin text-11" />
                            ) : (
                                <i className="fa fa-solid fa-trash-can text-11" />
                            )}
                            Delete {going.length} branch(es)
                        </button>
                    ) : null}
                </div>
            </div>
        </div>,
        document.body
    );
}

// The one-time offer to let GitHub delete head branches on merge, so they stop piling up (#571). It changes the
// repository setting only on Turn on; either answer is remembered by wavesrv and the offer is not made again.
function AutoDeleteOffer({
    done,
    busy,
    onAnswer,
}: {
    done: boolean;
    busy: boolean;
    onAnswer: (enable: boolean) => void;
}) {
    if (done) {
        return (
            <div
                className="rounded-6 border border-border px-3 py-2 text-12 text-secondary"
                data-testid="autodelete-offer"
            >
                <i className="fa fa-solid fa-check mr-1.5 text-11 text-success" />
                GitHub now deletes head branches when their pull request is merged.
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-2 rounded-6 border border-border px-3 py-2" data-testid="autodelete-offer">
            <div className="text-12 text-secondary">
                GitHub keeps head branches after their pull request is merged on this repository. Turn on its
                “Automatically delete head branches” setting so merged branches stop piling up?
            </div>
            <div className="flex justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => onAnswer(false)} className={PlainButton}>
                    Not now
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAnswer(true)}
                    className="molten-btn cursor-pointer rounded-6 px-3 py-1 text-12 disabled:cursor-default disabled:opacity-60"
                >
                    {busy ? <i className="fa fa-solid fa-circle-notch fa-spin mt-step-spin mr-1 text-11" /> : null}
                    Turn on
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}

export function BranchCleanupButton({ dir, onCleaned }: { dir: string; onCleaned: () => void }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)} className={ActionSecondaryClass}>
                <i className="fa fa-solid fa-broom text-11" />
                Clean branches
            </button>
            {open ? <BranchCleanupDialog dir={dir} onClose={() => setOpen(false)} onCleaned={onCleaned} /> : null}
        </>
    );
}
