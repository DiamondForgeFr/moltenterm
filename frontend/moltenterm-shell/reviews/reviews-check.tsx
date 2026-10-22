// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Check the agents (#954, FR-REV-022 AC8): at the top of the Reviews list, on the developer's click only, the agent on
// each listed PR with something left (conflicts, red CI, requested changes, no test report) is asked to verify the PR
// against its ticket and finish it; the others are skipped and a busy agent is left alone. The PRs whose agent is gone
// wait for one confirmation before a new agent starts on each, out of sight. A line reports the count, and each row's
// agent line then follows its task (working, done, stuck).

import { fireAndForget } from "@/util/util";
import { useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import type { ReviewPr } from "./reviews-model";
import { ReviewsModel } from "./reviews-store";
import { CheckReport, checkReportText } from "./reviews-task-model";

const PlainButton =
    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 border border-border px-1.5 py-0.5 text-11 leading-4 text-secondary hover:bg-hover hover:text-primary";

export function CheckAgentsBar({ dir, repo, prs }: { dir: string; repo: string; prs: ReviewPr[] }) {
    const t = useT();
    const tCount = useTCount();
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState<CheckReport>(null);
    if (!prs?.length) {
        return null;
    }
    const model = ReviewsModel.getInstance();
    const run = (fn: () => Promise<CheckReport>) => {
        if (busy) {
            return;
        }
        setBusy(true);
        fireAndForget(async () => {
            try {
                setReport(await fn());
            } finally {
                setBusy(false);
            }
        });
    };
    const offers = report?.offers ?? [];
    return (
        <div className="flex flex-col gap-1.5" data-testid="reviews-check">
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={() => run(() => model.checkAgents(dir, repo, prs))}
                    aria-busy={busy || undefined}
                    className={PlainButton}
                    title={t("reviews.check.buttonTitle")}
                    data-testid="reviews-check-button"
                >
                    {busy ? <DominoLoader /> : <i className="fa fa-solid fa-list-check text-10" aria-hidden />}
                    {busy ? t("reviews.check.checking") : t("reviews.check.button")}
                </button>
                {report != null ? (
                    <span className="min-w-0 text-11 text-muted" role="status" data-testid="reviews-check-report">
                        {checkReportText(tCount, report)}
                    </span>
                ) : null}
            </div>
            {offers.length > 0 ? (
                <div
                    className="flex flex-wrap items-center gap-2 rounded-4 border border-warning/40 bg-warning/10 px-2 py-1.5 text-12"
                    data-testid="reviews-check-offers"
                >
                    <span className="min-w-0 grow">
                        {t("reviews.check.offers", { list: offers.map((pr) => `#${pr.number}`).join(", ") })}
                    </span>
                    <button
                        type="button"
                        onClick={() => run(() => model.startOffers(dir, repo, report))}
                        className="molten-btn cursor-pointer rounded-4 px-2 py-0.5 text-11"
                        data-testid="reviews-check-start"
                    >
                        {tCount("reviews.check.start", offers.length)}
                        <MoltenWave />
                    </button>
                    <button
                        type="button"
                        onClick={() => setReport({ ...report, offers: [] })}
                        className={PlainButton}
                        data-testid="reviews-check-skip"
                    >
                        {t("reviews.check.notNow")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
