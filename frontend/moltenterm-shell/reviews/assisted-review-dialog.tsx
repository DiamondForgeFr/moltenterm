// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Assisted review's confirmation (FR-REV-033, #1352): nothing starts unasked (#758), so before the agent starts on the
// PR this dialog says what will happen. Start the agent (the default, Enter) opens the Review tab with the agent on the
// left of the diff (DS-REV-012); Diff only opens it as before, the AI panel button starting the agent later; Cancel and
// Escape open nothing.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";

export type AssistedReviewAnswer = "agent" | "diff";

export type AssistedReviewRequest = {
    number: number;
    branch: string;
    base: string;
    // The agent that would start (its name), "" when it is not known yet.
    agent?: string;
};

export type PendingAssistedReview = AssistedReviewRequest & { answer: (choice: AssistedReviewAnswer) => void };

const PlainButton =
    "cursor-pointer rounded-4 border border-border px-3 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";

export class AssistedReviewModel {
    private static instance: AssistedReviewModel = null;

    pendingAtom = atom(null) as PrimitiveAtom<PendingAssistedReview>;

    private constructor() {}

    static getInstance(): AssistedReviewModel {
        if (AssistedReviewModel.instance == null) {
            AssistedReviewModel.instance = new AssistedReviewModel();
        }
        return AssistedReviewModel.instance;
    }

    // ask resolves with the developer's choice, null when they cancel (or another ask replaced this one).
    ask(req: AssistedReviewRequest): Promise<AssistedReviewAnswer> {
        globalStore.get(this.pendingAtom)?.answer(null);
        return new Promise((resolve) => {
            globalStore.set(this.pendingAtom, {
                ...req,
                answer: (choice) => {
                    globalStore.set(this.pendingAtom, null);
                    resolve(choice);
                },
            });
        });
    }

    // nameAgent shows the agent's name once it is known, while the same ask is still open.
    nameAgent(number: number, agent: string) {
        const pending = globalStore.get(this.pendingAtom);
        if (pending == null || pending.number !== number || !agent) {
            return;
        }
        globalStore.set(this.pendingAtom, { ...pending, agent });
    }
}

export function AssistedReviewHost() {
    const pending = useAtomValue(AssistedReviewModel.getInstance().pendingAtom);
    if (pending == null) {
        return null;
    }
    return <AssistedReviewDialog key={pending.number} pending={pending} />;
}

export function AssistedReviewDialog({ pending }: { pending: PendingAssistedReview }) {
    const t = useT();
    const startRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        startRef.current?.focus();
    }, []);
    const vars = {
        number: pending.number,
        branch: pending.branch,
        base: pending.base,
        agent: pending.agent || t("assistedReview.yourAgent"),
    };
    return (
        <DialogFrame
            role="assisted-review"
            onEscape={() => pending.answer(null)}
            title={t("assistedReview.title", vars)}
            subtitle={t("assistedReview.subtitle", vars)}
            widthClass="w-[480px]"
            trapFocus
            buttons={
                <>
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => pending.answer(null)}
                        data-testid="assisted-review-cancel"
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => pending.answer("diff")}
                        data-testid="assisted-review-diff"
                    >
                        {t("assistedReview.openDiff")}
                    </button>
                    <button
                        ref={startRef}
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12"
                        onClick={() => pending.answer("agent")}
                        data-testid="assisted-review-start"
                    >
                        {t("assistedReview.start")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <div className="flex flex-col gap-3 text-12 leading-5" data-testid="assisted-review">
                <p className="text-secondary">{t("assistedReview.what", vars)}</p>
                <p className="text-muted">{t("assistedReview.diffOnly")}</p>
            </div>
        </DialogFrame>
    );
}
