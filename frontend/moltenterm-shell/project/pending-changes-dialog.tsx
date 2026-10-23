// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What would ship (#903, FR-MC-021), opened from the header band's Waiting block: the pending changes grouped by
// ticket. The commits are the header's; the PRs and tickets come from the merged history (#960), asked again while
// wavesrv reads it. Without GitHub the list comes from git alone and says so.

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { useLocale, useT, useTCount } from "../i18n/i18n";
import type { MissionGit } from "../mission/mission-model";
import { HistoryPollMs, MergedHistoryStore } from "../reviews/merged-history-model";
import { DominoLoader } from "../suite/suite";
import { countsLine, githubBase, WaitingCounts } from "./next-station-model";
import { pendingCommits } from "./overview-cards-model";
import { ShipListView } from "./ship-list";
import { flatGroups, shipList } from "./ship-list-model";

export function PendingChangesDialog({
    dir,
    git,
    tag,
    counts,
    onClose,
}: {
    dir: string;
    git: MissionGit;
    // The release it waits for; null when no version is due.
    tag: string;
    counts: WaitingCounts;
    onClose: () => void;
}) {
    const t = useT();
    const tCount = useTCount();
    useLocale();
    const store = MergedHistoryStore.getInstance();
    const answers = useAtomValue(store.answersAtom);
    const answer = answers[dir];
    const [askError, setAskError] = useState<string>(null);

    useEffect(() => {
        let alive = true;
        let timer: ReturnType<typeof setTimeout> = null;
        const ask = async () => {
            try {
                const next = await store.load(dir);
                if (!alive) {
                    return;
                }
                setAskError(null);
                if (next?.loading) {
                    timer = setTimeout(() => fireAndForget(ask), HistoryPollMs);
                }
            } catch (e) {
                if (alive) {
                    setAskError(String(e?.message ?? e));
                }
            }
        };
        fireAndForget(ask);
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [dir]);

    const commits = useMemo(() => pendingCommits(git), [git]);
    const base = githubBase(git?.remoteurl);
    const list = useMemo(
        () =>
            shipList(commits, askError ? { error: askError } : (answer ?? { prs: [] }), (n) =>
                base ? `${base}/issues/${n}` : ""
            ),
        [commits, answer, askError, base]
    );
    const tickets = flatGroups(list.groups).filter((g) => g.ticket > 0).length;
    const loading = !list.gitOnly && (answer == null || answer.loading);
    const trunk = git?.trunk || "develop";
    return (
        <DialogFrame
            role="pending-changes"
            onEscape={onClose}
            onBackdrop={onClose}
            title={tag ? t("project.ship.title", { tag }) : t("project.ship.titleTrunk", { trunk })}
            subtitle={[
                counts ? `${counts.total} ${counts.scope}` : "",
                countsLine(counts),
                tCount("project.ship.tickets", tickets),
            ]
                .filter((s) => s)
                .join(" · ")}
            widthClass="w-[860px]"
            buttons={
                <button
                    type="button"
                    onClick={onClose}
                    className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                >
                    {t("common.close")}
                </button>
            }
        >
            <div className="-mx-4 -my-3 flex h-[min(72vh,640px)] min-h-0 flex-col" data-testid="pending-changes">
                {list.gitOnly || loading ? (
                    <div
                        className="border-b border-border px-4 py-1.5 text-11 text-muted"
                        title={list.gitOnly ? (askError ?? answer?.error ?? undefined) : undefined}
                        data-testid="pending-changes-status"
                    >
                        {loading ? <DominoLoader className="mr-1.5 text-accent" /> : null}
                        {list.gitOnly ? t("project.ship.gitOnly") : t("project.ship.loading")}
                    </div>
                ) : null}
                <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                    {list.groups.length === 0 ? (
                        <p className="px-2 text-12 text-muted" data-testid="pending-changes-empty">
                            {t("project.ship.none", { trunk })}
                        </p>
                    ) : (
                        <ShipListView groups={list.groups} />
                    )}
                </div>
            </div>
        </DialogFrame>
    );
}
