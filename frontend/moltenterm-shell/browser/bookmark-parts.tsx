// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The small pieces the bookmark popover, the column panel and Settings share (#2531): the marker of a place, a name with
// the letters found underlined, a bookmark's icon with its shortcut mark, and the texts that say what a place is.

import { cn } from "@/util/util";
import { AppWindow, ArrowUpRight, FolderGit2 } from "lucide-react";
import { type TFunction } from "../i18n/i18n";
import { AddressIcon } from "../favicon/favicon-mark";
import { Bookmark, LevelApp, LevelContext, LevelProject, PlaceLevel, PlaceRef } from "./bookmarks";
import "./bookmarks.css";

// The marker of a level: the app's window, the context's ribbon end, the workspace's dot in its colour, the project's
// repository icon. Colour is the place colour (the workspace's); the app and the project stay neutral.
export function PlaceMarker({ level, color }: { level: PlaceLevel; color?: string }) {
    if (level === LevelApp) {
        return <AppWindow className="molten-bm-marker" aria-hidden />;
    }
    if (level === LevelProject) {
        return <FolderGit2 className="molten-bm-marker" aria-hidden />;
    }
    const style = color ? ({ "--molten-bm-place": color } as React.CSSProperties) : undefined;
    return level === LevelContext ? (
        <span className="molten-bm-ribbon" style={style} aria-hidden />
    ) : (
        <span className="molten-bm-dot" style={style} aria-hidden />
    );
}

// A name with the letters of a search underlined. The positions index the name by code points.
export function HighlightedName({ name, positions }: { name: string; positions: readonly number[] }) {
    if (positions.length === 0) {
        return <>{name}</>;
    }
    const marked = new Set(positions);
    return (
        <>
            {Array.from(name).map((ch, i) =>
                marked.has(i) ? (
                    <u key={i} className="molten-bm-found">
                        {ch}
                    </u>
                ) : (
                    <span key={i}>{ch}</span>
                )
            )}
        </>
    );
}

// A bookmark's site icon; a bookmark placed at several places wears the small shortcut mark, like an alias.
export function BookmarkMark({ bookmark, className }: { bookmark: Bookmark; className?: string }) {
    const shared = bookmark.places.length > 1;
    return (
        <span className={cn("molten-bm-mark", className)} data-shared={shared ? "true" : undefined}>
            <AddressIcon address={bookmark.url} />
            {shared ? <ArrowUpRight className="molten-bm-alias" strokeWidth={3} aria-hidden /> : null}
        </span>
    );
}

export function levelWord(t: TFunction, level: PlaceLevel): string {
    return t(`browser.bookmarks.level.${level}`);
}

// "Workspace · Échanges": the row of a place, from its level and its name (the app has no name of its own).
export function placeTitle(t: TFunction, ref: PlaceRef, name: string): string {
    return ref.level === LevelApp ? t("browser.bookmarks.place.app") : t(`browser.bookmarks.place.${ref.level}`, { name });
}

// The sentence under a place that says where a bookmark placed there is visible.
export function placeHint(t: TFunction, level: PlaceLevel): string {
    return t(`browser.bookmarks.placeHint.${level}`);
}

// The names above a place, joined for a result's path.
export function pathText(path: readonly string[]): string {
    return path.join(" › ");
}
