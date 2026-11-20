// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The two small pieces the comment field and the review share (FR-BRW-017 AC21, AC22, #2327): the reference images of a
// comment as thumbnails, and its links as chips.

import { useT } from "../i18n/i18n";
import type { ZoneLink, ZoneRef } from "./annotate-model";

// The reference images attached to a comment, as small thumbnails, each with its remove.
export function RefThumbs({ refs, onRemove }: { refs: ZoneRef[]; onRemove?: (refId: number) => void }) {
    const t = useT();
    if (refs.length === 0) {
        return null;
    }
    return (
        <ul className="flex flex-wrap gap-2" data-testid="browser-annotate-refs">
            {refs.map((r, i) => (
                <li key={r.id} className="relative" data-testid="browser-annotate-ref">
                    <img
                        src={r.dataUrl}
                        alt={t("browser.annotate.ref.alt", { n: i + 1 })}
                        className="h-12 w-12 rounded-4 border border-border object-cover"
                    />
                    {onRemove != null ? (
                        <button
                            type="button"
                            className="absolute -top-1.5 -right-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-border bg-surface-3 text-muted hover:text-primary"
                            title={t("browser.annotate.ref.remove")}
                            aria-label={t("browser.annotate.ref.remove")}
                            onClick={() => onRemove(r.id)}
                            data-testid="browser-annotate-ref-remove"
                        >
                            <i className="fa fa-solid fa-xmark text-10" aria-hidden />
                        </button>
                    ) : null}
                </li>
            ))}
        </ul>
    );
}

// The links of a comment, as chips with the host name: they stay in the text, and nothing opens or fetches them.
export function LinkChips({ links }: { links: ZoneLink[] }) {
    if (links.length === 0) {
        return null;
    }
    return (
        <ul className="flex flex-wrap gap-1.5" data-testid="browser-annotate-links">
            {links.map((link) => (
                <li
                    key={link.href}
                    title={link.href}
                    className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-4 border border-border bg-surface-2 px-1.5 py-0.5 text-11 text-secondary"
                    data-testid="browser-annotate-link"
                >
                    <i className="fa fa-solid fa-link shrink-0 text-10 text-muted" aria-hidden />
                    <span className="truncate">{link.host}</span>
                </li>
            ))}
        </ul>
    );
}
