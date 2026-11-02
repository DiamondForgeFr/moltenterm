// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What works with an agent (FR-AGC-004, #1685): the same few lines on every agent card, from the compatibility matrix.
// Showing it reads data only; the details open on a click, nothing else opens or runs.

import { cn } from "@/util/util";
import { useId, useState } from "react";
import { useLocale, useT } from "../i18n/i18n";
import { useFeatureMatrix } from "./agent-features-model";
import {
    agentWorks,
    detailLevelKey,
    groupWords,
    reasonKey,
    type WorksDetail,
    type WorksItem,
} from "./agent-works-model";

function GroupLine({ labelKey, items, muted }: { labelKey: string; items: WorksItem[]; muted?: boolean }) {
    const t = useT();
    const locale = useLocale();
    if (items.length === 0) {
        return null;
    }
    return (
        <span className={muted ? "text-muted" : undefined} data-testid="agent-works-group">
            <span className="text-muted">{t(labelKey)}</span> {groupWords(items, t, locale)}
        </span>
    );
}

function DetailLine({ detail }: { detail: WorksDetail }) {
    const t = useT();
    const dot = detail.level === "works" ? "bg-success" : detail.level === "partly" ? "bg-warning" : "bg-white/[0.25]";
    return (
        <li className="flex items-start gap-1.5" data-testid="agent-works-detail" data-level={detail.level}>
            <span className={cn("mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full", dot)} aria-hidden />
            <span className="min-w-0">
                <span className="inline-block text-primary first-letter:uppercase">
                    {t(`agentWorks.feature.${detail.feature}`)}
                </span>
                <span className="text-muted">
                    {" · "}
                    {t(detailLevelKey(detail))}
                    {detail.reason ? ` — ${t(reasonKey(detail.reason))}` : ""}
                </span>
            </span>
        </li>
    );
}

// agent: an agent id or a catalog profile id. The glance: what MoltenTerm follows, what the agent can use, what it
// cannot yet; the details list each feature with why it is not native.
export function AgentWorks({ agent, className }: { agent: string; className?: string }) {
    const t = useT();
    const matrix = useFeatureMatrix();
    const [open, setOpen] = useState(false);
    const detailsId = useId();
    if (matrix == null) {
        return null;
    }
    const works = agentWorks(matrix, agent);
    if (!works.known) {
        return (
            <div className={cn("text-11 text-muted", className)} data-testid="agent-works">
                {t("agentWorks.unknown")}
            </div>
        );
    }
    return (
        <div className={cn("flex flex-col gap-0.5 text-11 text-secondary", className)} data-testid="agent-works">
            <GroupLine labelKey="agentWorks.follows" items={works.follows} />
            <GroupLine labelKey="agentWorks.uses" items={works.uses} />
            <GroupLine labelKey="agentWorks.notYet" items={works.missing} muted />
            <button
                type="button"
                className="mt-0.5 w-fit cursor-pointer border-0 bg-transparent p-0 text-left text-11 text-muted underline-offset-2 hover:text-secondary hover:underline"
                aria-expanded={open}
                aria-controls={detailsId}
                onClick={() => setOpen(!open)}
                data-testid="agent-works-toggle"
            >
                {t(open ? "agentWorks.hideDetails" : "agentWorks.details")}
            </button>
            {open ? (
                <ul id={detailsId} className="mt-1 flex flex-col gap-1" data-testid="agent-works-details">
                    {works.details.map((d) => (
                        <DetailLine key={d.feature} detail={d} />
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
