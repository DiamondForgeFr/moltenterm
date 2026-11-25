// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The two bookmark buttons of the web page panel's row (FR-BRW-019, FR-BRW-025, #2531, mockup section 1): the add button
// (Lucide bookmark) directly after Reload, filled while the shown page is a bookmark visible from here and folding with
// Reload, and the panel button (Lucide book-marked) at the place of the former Bookmarks button, which takes only the
// row's active fill while the panel is open. The popover the add button opens is hosted at the panel's level, since the
// "⋯" it folds into opens it too.

import { cn } from "@/util/util";
import { useAtomValue, type PrimitiveAtom } from "jotai";
import { Bookmark as BookmarkIcon, BookMarked } from "lucide-react";
import { lazy, Suspense } from "react";
import { useT } from "../i18n/i18n";
import { bookmarkablePage, pageState } from "./bookmarks";
import type { PopoverRequest } from "./bookmark-popover-model";
import { useBookmarkStore, useHere } from "./bookmark-world";
import "./bookmark-buttons.css";

const BookmarkPopover = lazy(() => import("./bookmark-popover").then((m) => ({ default: m.BookmarkPopover })));

// The size and stroke of the row's other Lucide icon (the Comment button), set on the icon itself: a stylesheet that
// loads later leaves Lucide's 24 px until it does (#2560).
const RowIconSize = 14;
const RowIconStroke = 2;

const RowButton =
    "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary disabled:pointer-events-none disabled:opacity-40";

export function BookmarkAddButton({
    tabId,
    pageUrl,
    onClick,
    className,
}: {
    tabId: string;
    pageUrl: string;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    className?: string;
}) {
    const t = useT();
    const store = useBookmarkStore();
    const here = useHere(tabId);
    const page = bookmarkablePage(pageUrl);
    const state = page === "" ? { kind: "none" as const } : pageState(store, here, page);
    const saved = state.kind === "here";
    const label = t(saved ? "browser.bookmarks.add.edit" : "browser.bookmarks.add.add");
    return (
        <button
            type="button"
            aria-label={label}
            title={page === "" ? t("browser.bookmarks.add.none") : label}
            disabled={page === ""}
            onClick={onClick}
            data-testid="browser-bookmark-add"
            data-saved={saved ? "true" : "false"}
            data-state={state.kind}
            className={cn(RowButton, className)}
        >
            <BookmarkIcon
                className={cn("molten-bm-add-icon", saved && "is-saved")}
                size={RowIconSize}
                strokeWidth={RowIconStroke}
                fill={saved ? "currentColor" : "none"}
                aria-hidden
            />
        </button>
    );
}

export function BookmarksPanelButton({
    open,
    onClick,
    className,
}: {
    open: boolean;
    onClick: () => void;
    className?: string;
}) {
    const t = useT();
    const label = t("browser.bookmarks.button");
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={open}
            onClick={onClick}
            data-testid="browser-bookmarks-button"
            className={cn(RowButton, "molten-bm-book", className)}
        >
            <BookMarked
                className="molten-bm-book-icon"
                size={RowIconSize}
                strokeWidth={RowIconStroke}
                aria-hidden
            />
        </button>
    );
}

// The popover of the add button, shown while the model holds a request for it.
export function BookmarkPopoverHost({
    atom,
    tabId,
    onClose,
    setRequest,
}: {
    atom: PrimitiveAtom<{ anchor: Element; request: PopoverRequest }>;
    tabId: string;
    onClose: () => void;
    setRequest: (request: PopoverRequest) => void;
}) {
    const open = useAtomValue(atom);
    if (open == null) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <BookmarkPopover
                anchor={open.anchor}
                tabId={tabId}
                request={open.request}
                setRequest={setRequest}
                onClose={onClose}
            />
        </Suspense>
    );
}
