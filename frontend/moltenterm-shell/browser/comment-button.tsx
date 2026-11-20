// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Comment button of the web page panel (FR-BRW-017 AC23, DS-BRW-024, #2422): a speech bubble with a plus, always shown
// right after Back and Forward, in no focus-only or folding group, so the developer sees at any time that commenting is
// possible. It is pressed while the mode is on and carries the number of comments pending; a click while it is on leaves
// the mode (the layer asks before comments would be lost). The tooltip names the shortcut with the glyphs of the platform.

import { isMacOS } from "@/util/platformutil";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { MessageSquarePlus } from "lucide-react";
import { useT, useTCount } from "../i18n/i18n";
import { formatShortcutById } from "../shortcuts/format";
import { annotatablePage, type AnnotateSession } from "./annotate-session";

export type CommentTab = { id: string; url: string; engine?: string };

export function CommentButton({
    session,
    tab,
    onStart,
}: {
    session: AnnotateSession;
    tab: CommentTab;
    onStart: () => void;
}) {
    const t = useT();
    const tc = useTCount();
    const opens = useAtomValue(session.openAtom);
    const counts = useAtomValue(session.countsAtom);
    if (tab == null) {
        return null;
    }
    const usable = !tab.engine && annotatablePage(tab.url);
    const on = opens.some((open) => open.tabId === tab.id);
    const count = counts[tab.id] ?? 0;
    const shortcut = formatShortcutById(isMacOS() ? "browser-annotate" : "browser-annotate-other");
    const label = t("browser.annotate.button");
    return (
        <button
            type="button"
            aria-label={count > 0 ? `${label}, ${tc("browser.annotate.tray.zones", count)}` : label}
            aria-pressed={on}
            aria-disabled={!usable}
            title={usable ? t("browser.annotate.buttonTitle", { shortcut }) : t("browser.annotate.buttonOff")}
            onClick={() => {
                if (!usable) {
                    return;
                }
                if (on) {
                    session.leave(tab.id);
                } else {
                    onStart();
                }
            }}
            data-testid="browser-annotate-button"
            className={cn(
                "relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary",
                on && "bg-hover text-primary",
                !usable && "opacity-40"
            )}
        >
            <MessageSquarePlus size={14} strokeWidth={2} aria-hidden />
            {count > 0 ? (
                <span
                    aria-hidden
                    className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--mt-action)] px-1 text-10 leading-none font-semibold text-white"
                    data-testid="browser-annotate-count-badge"
                >
                    {count}
                </span>
            ) : null}
        </button>
    );
}
