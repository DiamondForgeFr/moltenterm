// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Branch cleaning from the Project header (FR-MC-017), as Notulia's BranchCleanupDialog: the plan first, what would go
// and what stays with why, then nothing leaves without a click on the delete button. wavesrv checks each branch again
// before deleting it: the plan shown is not trusted blindly.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
    branchesClean,
    BranchesCleanResult,
    branchesPlan,
    BranchesPlan,
    BranchKeepReason,
    BranchPlan,
} from "./mission-client";

const KeepReasons: Record<BranchKeepReason, string> = {
    protected: "a main branch",
    "not-on-trunk": "its code is not on the trunk yet",
    "content-unknown": "git could not compare its content",
    "checked-out": "open in a worktree",
    "open-pr": "a pull request is open",
    "pr-unknown": "GitHub did not say whether it has a pull request",
};

const PlainButton =
    "cursor-pointer rounded border border-border px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary";

export function branchLabel(b: BranchPlan): string {
    return b.remote ? `origin/${b.name}` : b.name;
}

export function cleanResultLine(result: BranchesCleanResult): string {
    return `${result.deleted.length} branch(es) deleted${result.failed ? `, ${result.failed} failed` : ""}.`;
}

function BranchCleanupDialog({ dir, onClose, onCleaned }: { dir: string; onClose: () => void; onCleaned: () => void }) {
    const [plan, setPlan] = useState<BranchesPlan>(null);
    const [error, setError] = useState<string>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<BranchesCleanResult>(null);
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
        <div className="fixed inset-0 z-[9600] flex items-center justify-center bg-black/40" onPointerDown={onClose}>
            <div
                onPointerDown={(e) => e.stopPropagation()}
                className="flex max-h-[80vh] w-[620px] max-w-[calc(100vw-32px)] flex-col rounded border border-border bg-modalbg shadow-xl"
                data-testid="branch-cleanup"
            >
                <div className="border-b border-border px-4 py-3">
                    <div className="text-sm font-semibold">Clean branches</div>
                    <div className="mt-0.5 text-xs text-muted">
                        Branches whose code is already on {trunk} go, judged on content (rebase-merged pull requests
                        included). The main branches stay, and so does anything in doubt.
                    </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-xs">
                    {error ? (
                        <div className="mb-2 rounded border border-error/40 bg-error/10 px-2 py-1.5 text-error">
                            {error}
                        </div>
                    ) : null}
                    {plan == null && error == null ? (
                        <div className="flex items-center gap-2 text-muted">
                            <i className="fa fa-solid fa-circle-notch fa-spin text-[11px]" />
                            Comparing each branch with {trunk}…
                        </div>
                    ) : null}
                    {result ? (
                        <div className="flex flex-col gap-1">
                            <p className="text-sm text-primary" data-testid="cleanup-result">
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
                            <div>
                                <div className="mb-1.5 font-medium text-muted">Would go ({going.length})</div>
                                {going.length === 0 ? <p className="text-muted">Nothing to clean.</p> : null}
                                {going.map((b) => (
                                    <div key={branchLabel(b)} className="flex items-center gap-2 py-0.5">
                                        <i className="fa fa-solid fa-trash-can w-3.5 text-[11px] text-error" />
                                        <code>{branchLabel(b)}</code>
                                    </div>
                                ))}
                            </div>
                            <div>
                                <div className="mb-1.5 font-medium text-muted">Stay ({staying.length})</div>
                                {staying.map((b) => (
                                    <div key={branchLabel(b)} className="flex items-center gap-2 py-0.5">
                                        <i className="fa fa-solid fa-code-branch w-3.5 text-[11px] text-muted" />
                                        <code>{branchLabel(b)}</code>
                                        <span className="text-muted">— {KeepReasons[b.reason] ?? b.reason}</span>
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
                                "flex cursor-pointer items-center gap-1.5 rounded border border-error/60 bg-error/15 px-3 py-1 text-xs text-error transition-colors hover:bg-error/25 disabled:cursor-default disabled:opacity-50"
                            )}
                        >
                            {busy ? (
                                <i className="fa fa-solid fa-circle-notch fa-spin text-[10px]" />
                            ) : (
                                <i className="fa fa-solid fa-trash-can text-[10px]" />
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

export function BranchCleanupButton({ dir, onCleaned }: { dir: string; onCleaned: () => void }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="flex cursor-pointer items-center gap-1.5 rounded border border-border px-2 py-1 text-xs whitespace-nowrap text-secondary hover:bg-hover hover:text-primary"
            >
                <i className="fa fa-solid fa-broom text-[10px]" />
                Clean branches
            </button>
            {open ? <BranchCleanupDialog dir={dir} onClose={() => setOpen(false)} onCleaned={onCleaned} /> : null}
        </>
    );
}
