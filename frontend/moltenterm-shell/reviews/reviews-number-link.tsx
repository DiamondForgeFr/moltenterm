// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A ticket number or a PR number of the Integration panel as a link (#1921, FR-REV-001 AC19): the ticket's page or the
// pull request's page opens where the app opens every address it read from GitHub (openWebLink). Without an address
// the number stays plain text.

import { cn, fireAndForget } from "@/util/util";
import { useT } from "../i18n/i18n";
import { openWebLink } from "../open-web-link";

export type NumberLinkKind = "ticket" | "pr";

// The number's own click and keys stop at the number: the card around it opens its assisted review on a click or Enter,
// and the list walks its cards with the keys.
export function numberLinkHandlers(url: string) {
    return {
        onClick: (e: React.SyntheticEvent) => {
            e.stopPropagation();
            fireAndForget(() => openWebLink(url));
        },
        onKeyDown: (e: React.SyntheticEvent) => e.stopPropagation(),
    };
}

export function NumberLink({
    kind,
    number,
    url,
    className,
    title,
    testId,
    children,
}: {
    kind: NumberLinkKind;
    number: number;
    url: string;
    className?: string;
    title?: string;
    testId?: string;
    children: React.ReactNode;
}) {
    const t = useT();
    if (!url) {
        return (
            <span className={className} title={title || undefined} data-testid={testId}>
                {children}
            </span>
        );
    }
    const label = t(kind === "ticket" ? "reviews.card.openTicket" : "reviews.card.openPr", { number });
    return (
        <button
            type="button"
            {...numberLinkHandlers(url)}
            aria-label={label}
            title={title || label}
            className={cn(
                "cursor-pointer whitespace-nowrap hover:text-primary hover:underline focus-visible:text-primary focus-visible:underline",
                className
            )}
            data-link={kind}
            data-url={url}
            data-testid={testId}
        >
            {children}
        </button>
    );
}
