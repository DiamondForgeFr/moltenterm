// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The recent topics of the session (#555, #2441), as the body of their block: the session's own name, then each
// prompt with the facts of its work, the latest four, the rest under "Show N more". Display only, from the transcript.

import { useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { MoreButton } from "./companion-block";
import { MessageText } from "./companion-image-chip";
import type { LinkAgent } from "./companion-milestone-model";
import { CompanionView } from "./companion-model";
import { AgentRow, topicRows } from "./companion-recap-model";

// The topics the block lists before "Show N more".
export const TopicsShown = 4;

export function RecentTopicsSection({ view, now }: { view: CompanionView; now: number }) {
    const t = useT();
    const tCount = useTCount();
    const [open, setOpen] = useState(false);
    const rows = topicRows(view.topics, now);
    const name = view.session?.name;
    const shown = open ? rows : rows.slice(0, TopicsShown);
    const more = rows.length - shown.length;
    return (
        <div className="flex flex-col gap-1.5" data-testid="companion-topics">
            {name ? (
                <div className="truncate text-12 text-secondary" data-tip={name} data-testid="companion-name">
                    {name}
                </div>
            ) : null}
            {rows.length === 0 ? (
                <div className="mt-cb-empty">{t("companion.topics.empty")}</div>
            ) : (
                <ol className="mt-cwork-flush" data-bare={name ? undefined : ""}>
                    {shown.map((row) => (
                        <li key={row.key} className="mt-cdash-topic" data-tip={row.title} data-testid="companion-topic">
                            <span className="mt-cdash-topic-body">
                                <span className="mt-cdash-topic-text">
                                    <MessageText text={row.text} at={row.at} />
                                </span>
                                {row.facts.length > 0 ? (
                                    <span className="mt-cdash-topic-meta tabular-nums">{row.facts.join(" · ")}</span>
                                ) : null}
                            </span>
                        </li>
                    ))}
                    {more > 0 || (open && rows.length > TopicsShown) ? (
                        <li>
                            <MoreButton
                                more={more}
                                open={open}
                                onToggle={() => setOpen(!open)}
                                label={tCount("companion.dash.showMore", more, { count: more })}
                                lessLabel={t("companion.dash.showLess")}
                                testId="companion-topics-more"
                            />
                        </li>
                    ) : null}
                </ol>
            )}
        </div>
    );
}

// The link anchors of the milestone (#2392): each sub-agent row is an end a line reaches; hot when the pointer is on
// the ticket it works on, or on the line between them.
export type AgentLinkMarks = {
    ends?: ReadonlySet<string>;
    hot?: ReadonlySet<string>;
    heat?: (row: AgentRow) => string;
    // Whether a link shows as a chip, and the plan's steps that link to an agent (#2418, #2430).
    chips?: boolean;
    todoLinks?: ReadonlyMap<number, LinkAgent>;
};
