// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sub-agents of an agent in its "Everything about" window (FR-SHELL-084, #1542): the running ones first, the
// failures nobody has looked at yet, then one collapsed line "Done today · N" whose list is grouped by day. Nothing
// is cleared by hand: a finished sub-agent cannot be called back, and the sidebar drops it on its own. The window
// places this section wherever its layout wants it; it takes the agent and its companion, nothing else.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import type { AgentStateInfo } from "../agent-state-model";
import type { CompanionView } from "../companion/companion-model";
import { useLocale, useT, useTCount } from "../i18n/i18n";
import { AgentGlyph, WorkingDominoes } from "../sidebar/sidebar-agents";
import { agentRowLook } from "../sidebar/sidebar-agents-model";
import { SidebarGlyph } from "../sidebar/sidebar-icons";
import {
    subagentCardGroups,
    subagentDayLabel,
    subagentDays,
    subagentKindKey,
    subagentRows,
    type SubagentRow,
} from "./agent-info-model";
import { AgentInfoModel } from "./agent-info-store";
import { SectionTitle } from "./agent-info-window";

const LineButton =
    "flex w-full cursor-pointer items-center gap-2 rounded-6 px-2 py-1.5 text-left text-12 text-secondary hover:bg-white/[0.06] hover:text-primary";

function SubagentLine({ blockId, row }: { blockId: string; row: SubagentRow }) {
    const t = useT();
    const kindKey = subagentKindKey(row.kind);
    const kind = kindKey ? t(kindKey) : row.kind !== row.name ? row.kind : "";
    return (
        <button
            type="button"
            className={LineButton}
            data-testid="agent-info-sub"
            data-state={row.state}
            onClick={() => AgentInfoModel.getInstance().openSub(blockId, row.id)}
        >
            <AgentGlyph name="sub" size={14} />
            <span className="min-w-0 truncate text-primary">{row.name}</span>
            <span className="shrink-0 truncate text-muted">{[kind, row.model].filter(Boolean).join(" · ")}</span>
            <span className={cn("ml-auto shrink-0 text-11", row.state === "error" ? "text-danger" : "text-muted")}>
                {t(`agentInfo.subState.${row.state}`)}
            </span>
        </button>
    );
}

export function SubagentsSection({
    blockId,
    info,
    companion,
}: {
    blockId: string;
    info: AgentStateInfo;
    companion: CompanionView;
}) {
    const t = useT();
    const tc = useTCount();
    const locale = useLocale();
    const seenAll = useAtomValue(AgentInfoModel.getInstance().seenSubsAtom);
    const [open, setOpen] = useState(false);
    const rows = subagentRows(companion);
    if (rows.length === 0) {
        return null;
    }
    const groups = subagentCardGroups(rows, seenAll[blockId]);
    const now = Date.now();
    const days = subagentDays(groups.finished, now);
    const allToday = days.length === 1 && days[0].daysAgo === 0;
    // One loader: the window's head shows the agent's own while it works.
    const working = groups.working > 0 && agentRowLook(info) !== "working";
    return (
        <section data-testid="agent-info-subagents">
            <h5 className={cn(SectionTitle, "flex items-center gap-2")}>
                {t("agentInfo.subagents")}
                {working ? <WorkingDominoes /> : null}
            </h5>
            {[...groups.running, ...groups.unseen].map((s) => (
                <SubagentLine key={s.id} blockId={blockId} row={s} />
            ))}
            {groups.finished.length > 0 ? (
                <>
                    <button
                        type="button"
                        className={LineButton}
                        aria-expanded={open}
                        data-testid="agent-info-subs-done"
                        onClick={() => setOpen(!open)}
                    >
                        <span className={cn("flex", !open && "-rotate-90")}>
                            <SidebarGlyph name="chev" size={10} />
                        </span>
                        <span className="text-muted">
                            {tc(allToday ? "agentInfo.sub.doneToday" : "agentInfo.sub.doneAll", groups.finished.length)}
                        </span>
                    </button>
                    {open
                        ? days.map((day) => (
                              <div key={day.day} data-testid="agent-info-subs-day">
                                  {days.length > 1 || day.daysAgo !== 0 ? (
                                      <div className="px-2 pt-1.5 pb-0.5 text-11 text-muted">
                                          {subagentDayLabel(day, locale)}
                                      </div>
                                  ) : null}
                                  {day.rows.map((s) => (
                                      <SubagentLine key={s.id} blockId={blockId} row={s} />
                                  ))}
                              </div>
                          ))
                        : null}
                </>
            ) : null}
        </section>
    );
}
