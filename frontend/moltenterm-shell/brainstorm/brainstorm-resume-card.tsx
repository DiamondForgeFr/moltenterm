// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's resume card (FR-BOSS-009 AC92, FR-BOSS-010 AC10b and AC10e, DS-BOSS-013, #2303): the way back to the last
// brainstorm and his offer to reopen one, in the compact and the wide talk window alike. It is an opaque card of his
// group, so it reads over any terminal text: an eyebrow that says what it is, the title on one line (whole in its
// tooltip), the molten Resume and a quiet × for Not now. Each acts only on the developer's click. A light module: the
// talk window imports it directly, outside the brainstorm's own chunk (brainstorm-prompts.tsx loads on demand).

import { makeIconClass } from "@/util/util";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";

export type ResumeCardTestIds = { card: string; resume: string; dismiss: string };

export function ResumeCard({
    eyebrow,
    title,
    detail,
    label,
    busy = false,
    testIds,
    onResume,
    onDismiss,
}: {
    eyebrow: string;
    title: string;
    // A line under the title and Resume, such as its last change; none in the folded window's card.
    detail?: string;
    // The card's accessible name: what it offers, with the title.
    label: string;
    busy?: boolean;
    testIds: ResumeCardTestIds;
    onResume: () => void;
    onDismiss: () => void;
}) {
    const t = useT();
    const dismiss = t("boss.brainstorm.resumeDismiss");
    return (
        <div role="group" aria-label={label} className="mt-brokk-resume" data-testid={testIds.card}>
            <div className="mt-brokk-resume-top">
                <span className="mt-brokk-resume-eyebrow">
                    <i className={makeIconClass("clock-rotate-left", false)} aria-hidden />
                    <span className="mt-brokk-resume-eyebrow-text">{eyebrow}</span>
                </span>
                <button
                    type="button"
                    disabled={busy}
                    className="mt-brokk-resume-dismiss cursor-pointer"
                    aria-label={dismiss}
                    title={dismiss}
                    data-testid={testIds.dismiss}
                    onClick={onDismiss}
                >
                    <i className={makeIconClass("xmark", false)} aria-hidden />
                </button>
            </div>
            <div className="mt-brokk-resume-main">
                <span className="mt-brokk-resume-title" title={title} data-testid="brainstorm-resume-title">
                    {title}
                </span>
                <button
                    type="button"
                    disabled={busy}
                    className="molten-btn mt-brokk-resume-go cursor-pointer rounded-4 px-2.5 py-0.5 text-11 font-medium"
                    data-testid={testIds.resume}
                    onClick={onResume}
                >
                    {t("boss.brainstorm.resumeAction")}
                    <MoltenWave />
                </button>
            </div>
            {detail ? <span className="mt-brokk-resume-detail">{detail}</span> : null}
        </div>
    );
}
