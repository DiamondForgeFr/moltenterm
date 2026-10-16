// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The outdated terminal's update (FR-SHELL-041, DS-SHELL-076). Update terminal is a suggestion of the command panel
// (FR-SHELL-052, header/header-proposals.ts); the header hosts its dialog. Choosing it checks first: an idle shell is
// updated at once; an agent asks once; a busy terminal says what to finish first. The result shows in the same dialog
// only when there is something to say.

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { DialogFrame, useEscape } from "../dialog-frame";
import { useProposalRequest } from "../header/header-proposals";
import { t as translate, useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { TermUpdateOutcome } from "./termupdate-model";
import { termupdateMessage } from "./termupdate-text";
import { TermUpdates } from "./termupdate-store";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";
const PrimaryButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";

type DialogState = { kind: "confirm" | "result"; outcome: TermUpdateOutcome };

export function TermUpdateHost({ blockId }: { blockId: string }) {
    const outdated = useAtomValue(TermUpdates.getInstance().blockAtom(blockId));
    const [pending, setPending] = useState(false);
    const [dialog, setDialog] = useState<DialogState>(null);
    const store = TermUpdates.getInstance();
    const finish = (outcome: TermUpdateOutcome) => {
        if ((outcome.status === "updated" && !outcome.guessed) || outcome.status === "uptodate") {
            setDialog(null);
            return;
        }
        // An agent started between the check and the update: it still needs the user's yes.
        setDialog({ kind: outcome.status === "needconfirm" ? "confirm" : "result", outcome });
    };
    const run = (confirmed: boolean) =>
        fireAndForget(async () => {
            setPending(true);
            try {
                finish(await store.run(blockId, confirmed));
            } catch (e) {
                finish({ status: "failed", message: translate("termupdate.failedUpdate", { error: serverErrorText(e) }) });
            } finally {
                setPending(false);
            }
        });
    const start = () =>
        fireAndForget(async () => {
            setPending(true);
            let outcome: TermUpdateOutcome;
            try {
                outcome = await store.check(blockId);
            } catch (e) {
                outcome = { status: "failed", message: translate("termupdate.failedCheck", { error: serverErrorText(e) }) };
            }
            setPending(false);
            if (outcome.status === "ready") {
                run(false);
                return;
            }
            setDialog({ kind: outcome.status === "needconfirm" ? "confirm" : "result", outcome });
        });
    useProposalRequest(blockId, "termupdate", () => {
        if (outdated != null && !pending) {
            start();
        }
    });
    if (dialog == null) {
        return null;
    }
    return (
        <TermUpdateDialog
            state={dialog}
            pending={pending}
            onConfirm={() => run(true)}
            onClose={() => setDialog(null)}
        />
    );
}

function TermUpdateDialog({
    state,
    pending,
    onConfirm,
    onClose,
}: {
    state: DialogState;
    pending: boolean;
    onConfirm: () => void;
    onClose: () => void;
}) {
    const t = useT();
    useEscape(!pending, onClose);
    const { outcome } = state;
    const name = outcome.agentname || outcome.agent || t("termupdate.theAgent");
    if (state.kind === "confirm") {
        return (
            <DialogFrame
                role="molten-termupdate-dialog"
                title={t("termupdate.dialog.title", { agent: name })}
                subtitle={t("termupdate.dialog.subtitle")}
                trapFocus
                buttons={
                    <>
                        <button type="button" className={PlainButton} onClick={onClose} disabled={pending}>
                            {t("common.cancel")}
                        </button>
                        <button
                            type="button"
                            className={PrimaryButton}
                            onClick={onConfirm}
                            disabled={pending}
                            autoFocus
                        >
                            {pending ? <DominoLoader className="mr-1.5" /> : null}
                            {t("termupdate.dialog.restart", { agent: name })}
                            <MoltenWave />
                        </button>
                    </>
                }
            >
                <p className="text-secondary">{t("termupdate.dialog.body", { agent: name })}</p>
                <p className="text-muted">{t("termupdate.dialog.note", { agent: name })}</p>
            </DialogFrame>
        );
    }
    const title =
        outcome.status === "updated"
            ? t("termupdate.result.updated")
            : outcome.status === "busy" || outcome.status === "agentbusy"
              ? t("termupdate.result.notNow")
              : t("termupdate.result.notUpdated");
    return (
        <DialogFrame
            role="molten-termupdate-dialog"
            title={title}
            onBackdrop={onClose}
            buttons={
                <button type="button" className={PlainButton} onClick={onClose} autoFocus>
                    {t("common.close")}
                </button>
            }
        >
            <p className="text-secondary" data-role="molten-termupdate-message">
                {termupdateMessage(outcome)}
            </p>
            {outcome.command && outcome.status !== "updated" ? (
                <pre className="rounded-4 border border-border bg-black/30 px-2 py-1.5 font-mono text-11 text-secondary select-text">
                    {outcome.command}
                </pre>
            ) : null}
        </DialogFrame>
    );
}
