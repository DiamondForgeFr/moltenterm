// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The warning drawn over a tab whose navigation was held as a lookalike domain (#2482, FR-BRW-024), in place of the page,
// as the error page is. It says in plain words which known site the domain imitates, spells the real domain in monospace
// with what sets it apart, and offers two ways out: Back to safety (the primary action, which takes the focus) and
// Continue to the domain, remembered for it. It is a warning, never a block. Nothing was requested from the site.

import { cn } from "@/util/util";
import { useEffect, useRef } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { describeDifference, DifferenceScript, unicodeHost, type LookalikeHold } from "./lookalike";

// What sets the domain being opened apart from the one it imitates, in a few words.
export function useDifferenceText(hold: LookalikeHold): string {
    const t = useT();
    const difference = describeDifference(hold.domain, hold.resembles);
    const vars: Record<string, string> = { ...difference.vars, known: unicodeHost(hold.resembles) };
    if (difference.kind === DifferenceScript) {
        vars.script = t(`browser.lookalike.script.${difference.vars.script}`);
    }
    return t(`browser.lookalike.difference.${difference.kind}`, vars);
}

export function LookalikePage({
    hold,
    onBack,
    onContinue,
}: {
    hold: LookalikeHold;
    onBack: () => void;
    onContinue: () => void;
}) {
    const t = useT();
    const backRef = useRef<HTMLButtonElement>(null);
    // The warning is the page: the focus goes to the safe choice, never to Continue. A warning an agent's navigation caused
    // does not take the focus from the developer's work.
    useEffect(() => {
        if (!hold.agent) {
            backRef.current?.focus({ preventScroll: true });
        }
    }, [hold.url, hold.agent]);
    const known = unicodeHost(hold.resembles);
    const difference = useDifferenceText(hold);
    const continueLabel = t("browser.lookalike.continue", { domain: hold.host });
    return (
        <div
            className="molten-browser-lookalike absolute inset-0 z-[2] overflow-y-auto bg-surface-1"
            role="alertdialog"
            aria-label={t("browser.lookalike.aria")}
            data-testid="browser-lookalike-page"
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    onBack();
                }
            }}
        >
            <div className="flex min-h-full w-full items-center justify-center p-6">
                <div className="flex w-full max-w-[400px] flex-col items-center gap-2 text-center">
                    <span
                        className="flex h-10 w-10 items-center justify-center rounded-6 bg-error/15 text-error"
                        aria-hidden
                    >
                        <i className="fa fa-solid fa-triangle-exclamation text-icon-20" />
                    </span>
                    <div className="mt-1 text-13 leading-5 font-semibold text-primary" role="heading" aria-level={2}>
                        {t("browser.lookalike.title", { known })}
                    </div>
                    <p className="text-12 leading-[18px] text-secondary">
                        {t("browser.lookalike.real")}{" "}
                        <code
                            className="font-mono text-11 text-primary [overflow-wrap:anywhere]"
                            data-testid="lookalike-host"
                        >
                            {hold.host}
                        </code>
                        {`, ${difference}.`}
                    </p>
                    {hold.agent ? (
                        <p className="text-12 leading-[18px] text-secondary" data-testid="lookalike-agent-note">
                            {t("browser.lookalike.agentNote")}
                        </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                        <button
                            ref={backRef}
                            type="button"
                            data-testid="lookalike-back"
                            onClick={onBack}
                            className="molten-btn inline-flex h-row cursor-pointer items-center gap-1.5 rounded-6 px-3 text-12 font-medium"
                        >
                            {t("browser.lookalike.back")}
                            <MoltenWave />
                        </button>
                        <button
                            type="button"
                            data-testid="lookalike-continue"
                            title={t("browser.lookalike.continueTitle")}
                            aria-label={continueLabel}
                            onClick={onContinue}
                            className={cn(
                                "molten-btn-secondary inline-flex h-row max-w-full cursor-pointer items-center gap-1.5 rounded-6 px-3 text-12"
                            )}
                        >
                            <span className="min-w-0 truncate">{continueLabel}</span>
                        </button>
                    </div>
                    <p className="mt-2 text-11 leading-4 text-muted">{t("browser.lookalike.basis")}</p>
                </div>
            </div>
        </div>
    );
}
