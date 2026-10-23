// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The list of what would ship (#903, FR-MC-021): tickets nested along their parents, behaviour changes first, each row
// opening a light detail (PR summary, merged when and by whom, the commits, links to GitHub). It only shows the groups
// it is given (ship-list-model.ts), so a milestone's tickets (#904) use it as well.

import { cn, fireAndForget } from "@/util/util";
import { Fragment, useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { formatWhen } from "../mission/time-format";
import { openWebLink } from "../open-web-link";
import { OrphansKey, ShipFlag, ShipGroup } from "./ship-list-model";

const Chip =
    "inline-flex shrink-0 items-center gap-1 rounded-4 border px-1.5 py-0.5 text-11 leading-4 whitespace-nowrap";
const KindChip = {
    feat: "border-accent/40 bg-accent/10 text-accent",
    fix: "border-success/40 bg-success/10 text-success",
    other: "border-border bg-hover text-secondary",
};
const LinkChip = cn(Chip, "cursor-pointer border-border text-secondary hover:bg-hover hover:text-primary");
const KnownTypes = new Set([
    "feat",
    "fix",
    "chore",
    "docs",
    "refactor",
    "perf",
    "test",
    "ci",
    "build",
    "style",
    "revert",
]);

function useTypeLabel(): (type: string) => string {
    const t = useT();
    return (type: string) =>
        KnownTypes.has(type) ? t(`project.ship.types.${type}`) : type || t("project.ship.types.other");
}

function flagText(t: (key: string, vars?: Record<string, string | number>) => string, flag: ShipFlag): string {
    if (flag.from === "label") {
        return t("project.ship.flag.label", { label: flag.label ?? "" });
    }
    return flag.from === "section" ? t("project.ship.flag.section") : t("project.ship.flag.breaking");
}

function open(url: string) {
    fireAndForget(() => openWebLink(url));
}

function GroupDetail({ group }: { group: ShipGroup }) {
    const t = useT();
    return (
        <div className="flex flex-col gap-2 pt-1 pb-2 text-12" data-testid="ship-detail">
            {group.prs.length === 0 && group.key !== OrphansKey ? (
                <p className="text-muted">{t("project.ship.detail.noPr")}</p>
            ) : null}
            {group.prs.map((pr) => (
                <div key={pr.number} className="flex flex-col gap-1">
                    <p className="text-secondary">{pr.summary || t("project.ship.detail.noSummary")}</p>
                    <div className="flex flex-wrap items-center gap-1.5 text-11 text-muted">
                        <span>
                            {pr.mergedby
                                ? t("project.ship.detail.merged", {
                                      number: pr.number,
                                      when: formatWhen(pr.mergedat),
                                      who: pr.mergedby,
                                  })
                                : t("project.ship.detail.mergedNoWho", {
                                      number: pr.number,
                                      when: formatWhen(pr.mergedat),
                                  })}
                        </span>
                        {pr.url ? (
                            <button
                                type="button"
                                className={LinkChip}
                                onClick={() => open(pr.url)}
                                title={t("project.ship.detail.openPrTitle", { number: pr.number })}
                                data-testid="ship-open-pr"
                            >
                                <i className="fa fa-solid fa-code-pull-request text-10" aria-hidden />
                                {t("project.ship.detail.openPr", { number: pr.number })}
                            </button>
                        ) : null}
                    </div>
                </div>
            ))}
            {group.ticket > 0 && group.url ? (
                <div>
                    <button
                        type="button"
                        className={LinkChip}
                        onClick={() => open(group.url)}
                        title={t("project.ship.detail.openTicketTitle", { number: group.ticket })}
                        data-testid="ship-open-ticket"
                    >
                        <i className="fa fa-solid fa-ticket text-10" aria-hidden />
                        {t("project.ship.detail.openTicket", { number: group.ticket })}
                    </button>
                </div>
            ) : null}
            {group.commits.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                    <span className="text-11 font-semibold tracking-wide text-muted uppercase">
                        {t("project.ship.detail.commits")}
                    </span>
                    <ul className="flex flex-col gap-0.5" data-testid="ship-commits">
                        {group.commits.map((c) => (
                            <li key={c.sha} className="flex min-w-0 items-baseline gap-2 text-secondary">
                                <code className="shrink-0 text-11 text-muted">{c.sha.slice(0, 7)}</code>
                                <span className="truncate" title={c.subject}>
                                    {c.subject}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}

function GroupRow({ group, depth }: { group: ShipGroup; depth: number }) {
    const t = useT();
    const tCount = useTCount();
    const typeLabel = useTypeLabel();
    const [expanded, setExpanded] = useState(false);
    const orphans = group.key === OrphansKey;
    const title = orphans
        ? t("project.ship.noTicket")
        : group.title ||
          (group.ticket === 0 && group.prs[0] ? t("project.ship.prTitle", { number: group.prs[0].number }) : "");
    const toggle = () => {
        if (!group.header) {
            setExpanded((v) => !v);
        }
    };
    return (
        <li className="flex flex-col" data-testid="ship-group" data-ticket={group.ticket || undefined}>
            <div
                role={group.header ? undefined : "button"}
                tabIndex={group.header ? undefined : 0}
                aria-expanded={group.header ? undefined : expanded}
                title={group.header ? undefined : expanded ? t("project.ship.hide") : t("project.ship.show")}
                onClick={toggle}
                onKeyDown={(e) => {
                    if ((e.key !== "Enter" && e.key !== " ") || e.target !== e.currentTarget) {
                        return;
                    }
                    e.preventDefault();
                    toggle();
                }}
                className={cn(
                    "flex flex-col gap-0.5 rounded-4 px-2 py-1.5 outline-none",
                    !group.header && "cursor-pointer hover:bg-hover focus-visible:bg-hover"
                )}
                style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
                data-testid="ship-row"
            >
                <div className="flex min-w-0 items-center gap-1.5 text-13">
                    {group.header ? null : (
                        <i
                            className={cn(
                                "fa fa-solid w-3 text-10 text-muted",
                                expanded ? "fa-chevron-down" : "fa-chevron-right"
                            )}
                            aria-hidden
                        />
                    )}
                    {group.header ? null : (
                        <span className={cn(Chip, KindChip[group.kind])} data-testid="ship-type">
                            {orphans && !group.type ? typeLabel("other") : typeLabel(group.type)}
                        </span>
                    )}
                    {group.tickettype ? (
                        <span className={cn(Chip, "border-border text-muted")}>{group.tickettype}</span>
                    ) : null}
                    {group.ticket > 0 ? <span className="shrink-0 text-accent">#{group.ticket}</span> : null}
                    <span
                        className={cn("min-w-0 truncate", group.header ? "font-semibold text-primary" : "text-primary")}
                    >
                        {title}
                    </span>
                    {group.commits.length > 0 ? (
                        <span className="ml-auto shrink-0 pl-2 text-11 text-muted tabular-nums">
                            {tCount("project.ship.commits", group.commits.length)}
                        </span>
                    ) : null}
                </div>
                {group.summary ? <p className="truncate pl-4.5 text-12 text-secondary">{group.summary}</p> : null}
                {group.flag ? (
                    <p className="flex items-start gap-1.5 pl-4.5 text-12 text-warning" data-testid="ship-flag">
                        <i className="fa fa-solid fa-triangle-exclamation mt-0.5 text-11" aria-hidden />
                        <span>
                            {flagText(t, group.flag)}
                            {group.flag.verify ? ` · ${t("project.ship.verify", { text: group.flag.verify })}` : ""}
                        </span>
                    </p>
                ) : group.flagged ? (
                    <p className="flex items-center gap-1.5 pl-4.5 text-12 text-warning">
                        <i className="fa fa-solid fa-triangle-exclamation text-11" aria-hidden />
                        {t("project.ship.underFlag")}
                    </p>
                ) : null}
                {expanded ? (
                    <div className="pl-4.5" onClick={(e) => e.stopPropagation()}>
                        <GroupDetail group={group} />
                    </div>
                ) : null}
            </div>
            {group.children.length > 0 ? (
                <ul className="flex flex-col">
                    {group.children.map((child) => (
                        <GroupRow key={child.key} group={child} depth={depth + 1} />
                    ))}
                </ul>
            ) : null}
        </li>
    );
}

export function ShipListView({ groups, className }: { groups: readonly ShipGroup[]; className?: string }) {
    const t = useT();
    const firstPlain = groups.findIndex((g) => !g.flagged);
    const hasFlagged = groups.some((g) => g.flagged);
    return (
        <ul className={cn("flex flex-col gap-0.5", className)} data-testid="ship-list">
            {groups.map((g, i) => (
                <Fragment key={g.key}>
                    {hasFlagged && i === 0 ? (
                        <li className="px-2 pt-1 text-11 font-semibold tracking-wide text-warning uppercase">
                            {t("project.ship.flaggedHeading")}
                        </li>
                    ) : null}
                    {hasFlagged && i === firstPlain && i > 0 ? (
                        <li className="mt-1 border-t border-border" aria-hidden />
                    ) : null}
                    <GroupRow group={g} depth={0} />
                </Fragment>
            ))}
        </ul>
    );
}
