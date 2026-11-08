// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The pill in the navigation row of the browser panel that started a download (FR-MC-019 AC9, #1992): a ring with the
// percentage while something downloads there, and nothing when nothing does. It says what it is (its tooltip and name)
// and opens the Downloads section when clicked; it never opens anything by itself and counts as no notification.
// It reads the DownloadsModel only, so it stays where it is whichever surface hosts the section.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useT, useTCount } from "../i18n/i18n";
import { overallDownloadProgress, percentOf, runningDownloads } from "./downloads-model";
import { DownloadsModel } from "./downloads-store";

const Radius = 13;
const Circumference = 2 * Math.PI * Radius;

export function DownloadRing({ progress, className }: { progress: number; className?: string }) {
    const shown = progress == null ? 0.25 : Math.max(0.04, Math.min(1, progress));
    return (
        <svg
            aria-hidden
            viewBox="0 0 30 30"
            className={cn("h-full w-full -rotate-90", progress == null && "mt-beat-turn", className)}
        >
            <circle
                cx="15"
                cy="15"
                r={Radius}
                fill="none"
                stroke="currentColor"
                strokeOpacity={0.2}
                strokeWidth={2.6}
            />
            <circle
                cx="15"
                cy="15"
                r={Radius}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={2.6}
                strokeLinecap="round"
                strokeDasharray={`${shown * Circumference} ${Circumference}`}
            />
        </svg>
    );
}

export function DownloadPill({ blockId }: { blockId: string }) {
    const t = useT();
    const tc = useTCount();
    const model = DownloadsModel.getInstance();
    const items = useAtomValue(model.itemsAtom, { store: globalStore });
    const here = runningDownloads(items).filter((r) => r.blockId === blockId);
    if (here.length === 0) {
        return null;
    }
    const progress = overallDownloadProgress(here);
    const percent = here.length === 1 ? percentOf(here[0]) : progress == null ? null : Math.floor(progress * 100);
    const label =
        here.length === 1 ? t("downloads.pill.one", { name: here[0].name }) : tc("downloads.pill.many", here.length);
    return (
        <button
            type="button"
            data-testid="download-pill"
            aria-label={label}
            title={label}
            onClick={() => model.request()}
            className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-6 border border-border pr-1.5 pl-1 text-11 text-primary tabular-nums hover:bg-hover"
        >
            <span className="relative flex h-4 w-4 items-center justify-center text-secondary">
                <span className="absolute inset-0">
                    <DownloadRing progress={progress} />
                </span>
                <i className={cn(makeIconClass("download", true), "text-10 text-accent")} aria-hidden />
            </span>
            {percent != null ? t("downloads.stats.percent", { percent }) : here.length > 1 ? String(here.length) : ""}
        </button>
    );
}
