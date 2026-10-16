// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Who made a pull request (#847): agents use the developer's GitHub account, so the PR's author says nothing. Each
// Reviews row, and the Review tab's header, shows the last agent's signature (Valentin · Claude Code · Opus 5.5 ·
// medium) read by wavesrv from the commits' Molten-Agent trailers and the body's signature block, every agent on hover.
// No signature reads "unknown agent": nothing is guessed.

import { cn, fireAndForget } from "@/util/util";
import { useEffect } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { reviewsGet, useReviewsAnswer } from "./reviews-client";
import { AgentSignature } from "./reviews-model";

export function signatureLine(sig: AgentSignature): string {
    if (sig == null) {
        return "";
    }
    return [sig.firstname, sig.agent, sig.model, sig.effort].filter((part) => part != null && part !== "").join(" · ");
}

// The agents of a PR the Reviews list knows; null when the list has not read this PR (the header then shows nothing).
export function usePrAgents(dir: string, num: number): AgentSignature[] {
    const answer = useReviewsAnswer(dir);
    const missing = answer == null;
    useEffect(() => {
        if (!dir || !missing) {
            return;
        }
        // The rail's passive ask: no GitHub read is started for it.
        fireAndForget(async () => {
            await reviewsGet(dir, false, true);
        });
    }, [dir, missing]);
    if (answer == null || !num) {
        return null;
    }
    const pr = [...(answer.ready ?? []), ...(answer.drafts ?? [])].find((p) => p.number === num);
    if (pr == null) {
        return null;
    }
    return pr.agents ?? [];
}

export function PrSignature({
    agents,
    className,
    testId = "pr-signature",
}: {
    agents: AgentSignature[];
    className?: string;
    testId?: string;
}) {
    const t = useT();
    const tCount = useTCount();
    const last = agents?.[0];
    if (last == null) {
        return (
            <div
                className={cn("flex min-w-0 items-center gap-1.5 text-11 text-muted italic", className)}
                title={t("reviews.signature.unknownTitle")}
                data-testid={testId}
                data-unknown="true"
            >
                <i className="fa fa-solid fa-robot text-10" aria-hidden="true" />
                <span className="truncate">{t("reviews.signature.unknown")}</span>
            </div>
        );
    }
    const line = signatureLine(last);
    const others = agents.length - 1;
    return (
        <div
            className={cn("flex min-w-0 items-center gap-1.5 text-11 text-muted", className)}
            title={t("reviews.signature.title", { list: agents.map(signatureLine).join("\n") })}
            aria-label={t("reviews.signature.aria", { who: line })}
            data-testid={testId}
        >
            <i className="fa fa-solid fa-robot text-10" aria-hidden="true" />
            <span className="truncate">{line}</span>
            {others > 0 ? (
                <span className="shrink-0 text-secondary">{tCount("reviews.signature.more", others)}</span>
            ) : null}
        </div>
    );
}
