// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Branch cleaning from the Project header (FR-MC-017), as Notulia's BranchCleanupDialog: the plan first, what would go
// and what stays with why, then nothing leaves without a click on the delete button. wavesrv checks each branch again
// before deleting it: the plan shown is not trusted blindly.

import { getApi } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useRestoreFocus } from "../busy-close";
import { DialogFrame } from "../dialog-frame";
import { t, tCount, useT, useTCount } from "../i18n/i18n";
import { serverErrorText, serverText, ServerText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { showPanel } from "../review/review-panels";
import { DurableSession, sessionName } from "../sessions/sessions-model";
import { DurableSessions } from "../sessions/sessions-store";
import { DominoLoader } from "../suite/suite";
import type { WorktreeTerminal } from "../worktree-model";
import { ActionSecondaryClass } from "./action-button";
import {
    branchesAutoDelete,
    branchesClean,
    BranchesCleanResult,
    branchesCloseAndClean,
    branchesPlan,
    BranchesPlan,
    BranchKeepReason,
    BranchPlan,
} from "./mission-client";

type PrKeepReason = "commits-after-pr" | "not-in-pr" | "worktree-changes" | "worktree-in-use";

const KeepReasonKeys: Record<Exclude<BranchKeepReason, PrKeepReason>, string> = {
    protected: "mc.branches.keep.protected",
    "not-on-trunk": "mc.branches.keep.notOnTrunk",
    "content-unknown": "mc.branches.keep.contentUnknown",
    "checked-out": "mc.branches.keep.checkedOut",
    "open-pr": "mc.branches.keep.openPr",
    "pr-unknown": "mc.branches.keep.prUnknown",
    "pr-assets": "mc.branches.keep.prAssets",
    "tool-branch": "mc.branches.keep.tool",
};

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";

export function branchLabel(b: BranchPlan): string {
    return b.remote ? `origin/${b.name}` : b.name;
}

// A session holding a merged PR's worktree open (#932): its terminal's block, and its name as the Sessions list shows
// it (else its tab's name).
export type BranchHolder = { blockid: string; name: string };

export function branchHolders(b: BranchPlan, sessions: DurableSession[], home: string): BranchHolder[] {
    if (b.reason !== "worktree-in-use" || b.remote) {
        return [];
    }
    return (b.terminals ?? []).map((term: WorktreeTerminal) => {
        const session = (sessions ?? []).find((s) => s.blockid === term.blockid);
        const name = session ? sessionName(session, home) : (term.tab ?? "").trim() || t("sessions.terminal");
        return { blockid: term.blockid, name };
    });
}

export function holdersText(holders: BranchHolder[]): string {
    return [...new Set(holders.map((h) => h.name))].join(", ");
}

// Why a branch goes or stays, as the list shows it next to the branch (#571); a worktree held open names who holds it.
export function branchReason(b: BranchPlan, trunk: string, holders?: BranchHolder[]): string {
    switch (b.reason) {
        case "merged-pr":
            return t("mc.branches.reason.mergedPr", { pr: b.pr });
        case "on-trunk":
            return t("mc.branches.reason.onTrunk", { trunk });
        case "patches-on-trunk":
            return t("mc.branches.reason.patchesOnTrunk", { trunk });
        case "commits-after-pr":
            return t("mc.branches.reason.commitsAfterPr", { pr: b.pr });
        case "merged-pr-worktree":
            return t("mc.branches.reason.mergedPrWorktree", { pr: b.pr });
        case "not-in-pr":
            return t("mc.branches.keep.notInPr", { pr: b.pr });
        case "worktree-changes":
            return t("mc.branches.keep.worktreeChanges", { pr: b.pr });
        case "worktree-in-use":
            if (holders?.length > 0) {
                return tCount("mc.branches.keep.worktreeHeldBy", holders.length, {
                    pr: b.pr,
                    sessions: holdersText(holders),
                });
            }
            return t("mc.branches.keep.worktreeInUse", { pr: b.pr });
    }
    const key = KeepReasonKeys[b.reason as keyof typeof KeepReasonKeys];
    return key ? t(key) : (b.reason ?? "");
}

// wavesrv keeps develop, main and their origin/ copies with the reason "protected", and no other branch (#920).
export function isMainBranch(b: BranchPlan): boolean {
    return b.action === "keep" && b.reason === "protected";
}

// A main branch takes the shell's info blue, apart from the delete red and the warning amber, so the secondary
// branches stand out at a glance; its reason stays next to it, the colour is never the only signal (#920).
export function KeptBranchRow({
    branch,
    trunk,
    holders,
}: {
    branch: BranchPlan;
    trunk: string;
    holders?: BranchHolder[];
}) {
    const main = isMainBranch(branch);
    return (
        <div className="flex items-center gap-2 py-0.5" data-main-branch={main ? "true" : undefined}>
            <i className={cn("fa fa-solid fa-code-branch w-3.5 text-11", main ? "text-info" : "text-muted")} />
            <code className={main ? "text-info" : undefined}>{branchLabel(branch)}</code>
            <span className="text-muted" title={branch.worktree}>
                — {branchReason(branch, trunk, holders)}
            </span>
        </div>
    );
}

// The sessions holding a merged PR's worktree open (#932): Show the session takes the window to it; Close the session
// and clean asks first, naming them and saying a running agent stops. wavesrv offers it only while nothing is
// uncommitted in the worktree (worktree-in-use), and checks that again before closing anything.
export function HeldBranchActions({
    branch,
    holders,
    busy,
    confirming,
    setConfirming,
    onShow,
    onCloseAndClean,
}: {
    branch: BranchPlan;
    holders: BranchHolder[];
    busy: boolean;
    confirming: boolean;
    setConfirming: (confirming: boolean) => void;
    onShow: (holder: BranchHolder) => void;
    onCloseAndClean: () => void;
}) {
    const t = useT();
    const tCount = useTCount();
    if (holders.length === 0) {
        return null;
    }
    const sessions = holdersText(holders);
    if (confirming) {
        return (
            <div
                role="alertdialog"
                aria-label={tCount("mc.branches.closeTitle", holders.length, { sessions })}
                className="my-1 ml-5.5 flex flex-col gap-2 rounded-6 border border-error/40 bg-error/10 px-3 py-2"
                data-testid="close-and-clean-confirm"
            >
                <div className="text-12 text-primary">
                    {tCount("mc.branches.closeConfirm", holders.length, { sessions, branch: branch.name })}
                </div>
                <div className="flex justify-end gap-2">
                    <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={PlainButton}>
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onCloseAndClean}
                        className="flex cursor-pointer items-center gap-1.5 rounded-6 border border-error/60 bg-error/15 px-3 py-1 text-12 text-primary transition-colors duration-120 ease-mt hover:bg-error/25 disabled:cursor-default disabled:opacity-50"
                    >
                        {busy ? <DominoLoader /> : <i className="fa fa-solid fa-power-off text-11" />}
                        {t("mc.branches.closeAndCleanConfirm")}
                    </button>
                </div>
            </div>
        );
    }
    return (
        <div className="mb-1 ml-5.5 flex flex-wrap items-center gap-1.5" data-testid="held-branch-actions">
            {holders.map((h) => (
                <button key={h.blockid} type="button" disabled={busy} onClick={() => onShow(h)} className={PlainButton}>
                    {holders.length === 1
                        ? t("mc.branches.showSession")
                        : t("mc.branches.showNamed", { session: h.name })}
                </button>
            ))}
            <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(true)}
                className={cn(PlainButton, "text-danger hover:text-danger")}
            >
                {tCount("mc.branches.closeAndClean", holders.length)}
            </button>
        </div>
    );
}

function homeDir(): string {
    try {
        return getApi()?.getHomeDir?.() ?? "";
    } catch {
        return "";
    }
}

// cleanErrorLines words the branches the cleaning could not delete; a kept branch's reason is worded as the list does.
export function cleanErrorLines(result: BranchesCleanResult, trunk: string): string[] {
    return (result?.errors ?? []).map((english, i) => {
        const text: ServerText = result.errorstext?.[i];
        if (text?.code !== "mission.branches.kept") {
            return serverText(text, english);
        }
        const vars = text.vars ?? {};
        const plan = {
            name: vars.branch,
            remote: false,
            action: "keep",
            reason: vars.reason,
            pr: Number(vars.pr) || 0,
        };
        return serverText({ ...text, vars: { ...vars, reason: branchReason(plan as BranchPlan, trunk) } }, english);
    });
}

export function cleanResultLine(result: BranchesCleanResult): string {
    return result.failed
        ? tCount("mc.branches.resultFailed", result.deleted.length, { failed: result.failed })
        : tCount("mc.branches.result", result.deleted.length);
}

export function BranchCleanupDialog({
    dir,
    onClose,
    onCleaned,
}: {
    dir: string;
    onClose: () => void;
    onCleaned: () => void;
}) {
    const t = useT();
    const tCount = useTCount();
    const [plan, setPlan] = useState<BranchesPlan>(null);
    const [error, setError] = useState<string>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<BranchesCleanResult>(null);
    // null while the offer is unanswered in this dialog, then "on" or "later".
    const [offerAnswer, setOfferAnswer] = useState<"on" | "later">(null);
    const [offerBusy, setOfferBusy] = useState(false);
    // A branch whose sessions were closed and cleaned (#932): its result line, and the plan read again.
    const [closing, setClosing] = useState<string>(null);
    const [confirmingClose, setConfirmingClose] = useState<string>(null);
    const [closedLines, setClosedLines] = useState<string[]>(null);
    const [planRound, setPlanRound] = useState(0);
    const sessionsData = useAtomValue(DurableSessions.getInstance().dataAtom);
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
                    setError(serverErrorText(e));
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dir, planRound]);
    const home = homeDir();
    const holdersOf = (b: BranchPlan) => branchHolders(b, sessionsData?.sessions, home);
    const showHolder = (holder: BranchHolder) =>
        fireAndForget(async () => {
            try {
                await showPanel(holder.blockid);
                onClose();
            } catch (e) {
                setError(serverErrorText(e));
            }
        });
    const closeAndClean = (b: BranchPlan) =>
        fireAndForget(async () => {
            setClosing(b.name);
            setError(null);
            try {
                const res = await branchesCloseAndClean(
                    dir,
                    b.name,
                    holdersOf(b).map((h) => h.blockid)
                );
                setClosedLines([cleanResultLine(res), ...cleanErrorLines(res, trunk)]);
                onCleaned();
                setPlanRound((n) => n + 1);
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setClosing(null);
                setConfirmingClose(null);
            }
        });
    const going = (plan?.branches ?? []).filter((b) => b.action === "delete");
    const staying = (plan?.branches ?? []).filter((b) => b.action === "keep");
    const nothingToDelete = plan != null && going.length === 0;
    const trunk = plan?.trunk || t("mc.builds.theTrunk");
    const answerOffer = (enable: boolean) =>
        fireAndForget(async () => {
            setOfferBusy(true);
            setError(null);
            try {
                await branchesAutoDelete(dir, enable);
                setOfferAnswer(enable ? "on" : "later");
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setOfferBusy(false);
            }
        });
    const closeRef = useRef<HTMLButtonElement>(null);
    useRestoreFocus();
    // Cancel takes the focus after useRestoreFocus noted where it was (autoFocus would come first), so Enter keeps
    // every branch; once the result shows, the delete button that had it is gone and Close takes it.
    useEffect(() => {
        closeRef.current?.focus();
    }, [result]);
    const clean = () =>
        fireAndForget(async () => {
            setBusy(true);
            setError(null);
            try {
                setResult(await branchesClean(dir, [...new Set(going.map((b) => b.name))]));
                onCleaned();
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setBusy(false);
            }
        });
    return (
        <DialogFrame
            role="branch-cleanup"
            onEscape={busy ? undefined : onClose}
            title={t("mc.branches.title")}
            subtitle={t("mc.branches.intro", { trunk })}
            subtitleWraps
            widthClass="w-[620px]"
            trapFocus
            onBackdrop={onClose}
            buttons={
                <>
                    <button ref={closeRef} type="button" onClick={onClose} className={PlainButton}>
                        {result || nothingToDelete ? t("common.close") : t("common.cancel")}
                    </button>
                    {/* No button with nothing to delete: a disabled red "Delete 0 branches" still looks clickable. */}
                    {!result && going.length > 0 ? (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={clean}
                            className={cn(
                                "flex cursor-pointer items-center gap-1.5 rounded-6 border border-error/60 bg-error/15 px-3 py-1 text-12 text-primary transition-colors duration-120 ease-mt hover:bg-error/25 disabled:cursor-default disabled:opacity-50"
                            )}
                        >
                            {busy ? <DominoLoader /> : <i className="fa fa-solid fa-trash-can text-11" />}
                            {tCount("mc.branches.delete", going.length)}
                        </button>
                    ) : null}
                </>
            }
        >
            <div data-testid="branch-cleanup">
                {error ? (
                    <div className="mb-2 rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-danger">
                        {error}
                    </div>
                ) : null}
                {plan == null && error == null ? (
                    <div className="flex items-center gap-2 text-muted">
                        <DominoLoader />
                        {t("mc.branches.comparing", { trunk })}
                    </div>
                ) : null}
                {result ? (
                    <div className="flex flex-col gap-1">
                        <p className="text-13 leading-5 text-primary" data-testid="cleanup-result">
                            {cleanResultLine(result)}
                        </p>
                        {cleanErrorLines(result, trunk).map((e, i) => (
                            <p key={i} className="text-muted">
                                {e}
                            </p>
                        ))}
                    </div>
                ) : plan ? (
                    <div className="flex flex-col gap-4">
                        {closedLines ? (
                            <div
                                className="flex flex-col gap-0.5 rounded-6 border border-border px-3 py-2 text-12"
                                role="status"
                                data-testid="close-and-clean-result"
                            >
                                {closedLines.map((line, i) => (
                                    <p key={i} className={i === 0 ? "text-primary" : "text-muted"}>
                                        {line}
                                    </p>
                                ))}
                            </div>
                        ) : null}
                        {plan.autodeleteoffer && offerAnswer !== "later" ? (
                            <AutoDeleteOffer done={offerAnswer === "on"} busy={offerBusy} onAnswer={answerOffer} />
                        ) : null}
                        <div>
                            <div className="mb-1.5 font-medium text-muted">
                                {t("mc.branches.wouldGo", { count: going.length })}
                            </div>
                            {going.length === 0 ? <p className="text-muted">{t("mc.branches.nothing")}</p> : null}
                            {going.map((b) => (
                                <div key={branchLabel(b)} className="flex items-center gap-2 py-0.5">
                                    <i className="fa fa-solid fa-trash-can w-3.5 text-11 text-error" />
                                    <code>{branchLabel(b)}</code>
                                    {b.reason ? (
                                        <span className="text-muted" title={b.worktree}>
                                            — {branchReason(b, trunk)}
                                        </span>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                        <div>
                            <div className="mb-1.5 font-medium text-muted">
                                {t("mc.branches.stay", { count: staying.length })}
                            </div>
                            {staying.map((b) => {
                                const holders = holdersOf(b);
                                return (
                                    <div key={branchLabel(b)}>
                                        <KeptBranchRow branch={b} trunk={trunk} holders={holders} />
                                        <HeldBranchActions
                                            branch={b}
                                            holders={holders}
                                            busy={closing != null || busy}
                                            confirming={confirmingClose === b.name}
                                            setConfirming={(on) => setConfirmingClose(on ? b.name : null)}
                                            onShow={showHolder}
                                            onCloseAndClean={() => closeAndClean(b)}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : null}
            </div>
        </DialogFrame>
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
    const t = useT();
    if (done) {
        return (
            <div
                className="rounded-6 border border-border px-3 py-2 text-12 text-secondary"
                data-testid="autodelete-offer"
            >
                <i className="fa fa-solid fa-check mr-1.5 text-11 text-success" />
                {t("mc.branches.autoDeleteDone")}
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-2 rounded-6 border border-border px-3 py-2" data-testid="autodelete-offer">
            <div className="text-12 text-secondary">{t("mc.branches.autoDeleteOffer")}</div>
            <div className="flex justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => onAnswer(false)} className={PlainButton}>
                    {t("mc.branches.notNow")}
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAnswer(true)}
                    className="molten-btn cursor-pointer rounded-6 px-3 py-1 text-12 disabled:cursor-default disabled:opacity-60"
                >
                    {busy ? <DominoLoader className="mr-1" /> : null}
                    {t("mc.branches.turnOn")}
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}

export function BranchCleanupButton({ dir, onCleaned }: { dir: string; onCleaned: () => void }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)} className={ActionSecondaryClass}>
                <i className="fa fa-solid fa-broom text-11" />
                {t("mc.branches.title")}
            </button>
            {open ? <BranchCleanupDialog dir={dir} onClose={() => setOpen(false)} onCleaned={onCleaned} /> : null}
        </>
    );
}
