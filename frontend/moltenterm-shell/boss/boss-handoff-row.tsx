// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The row of a hand-off request in the card's To handle tab (FR-BOSS-005, DS-BOSS-004): an agent asks to hand work to
// another, and the developer decides here or in the request's notification, which answer through the same route. The row
// says who asks whom, from which workspace, the goal in a line, what is attached and what the receiver would find, and
// offers Allow once, Always for this pair, Refuse and Read the brief (the full brief, nothing sent).

import { ReactNode, useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { workspaceShownName } from "../workspace-default-name";
import { GhostButton, PrimaryButton, RefuseButton, SecondaryButton } from "./boss-card-buttons";
import { HandoffRow, ToHandleAction, ToHandleItem } from "./boss-to-handle-model";

// The row names this many attachments, then says how many more.
export const HandoffNamesLimit = 3;

function initialOf(name: string): string {
    return Array.from(name.trim())[0]?.toUpperCase() ?? "";
}

function Party({ name, place, testId }: { name: string; place: string; testId: string }) {
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            <span
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-4 bg-surface-3 text-11 font-semibold text-primary"
                aria-hidden
            >
                {initialOf(name)}
            </span>
            <span className="min-w-0 truncate text-12 font-medium text-primary" data-testid={testId}>
                {name}
            </span>
            {place ? <span className="min-w-0 truncate text-11 text-muted">{place}</span> : null}
        </span>
    );
}

function HandoffButton({
    item,
    action,
    label,
    title,
    busy,
    expanded,
    onClick,
}: {
    item: ToHandleItem;
    action: ToHandleAction;
    label: string;
    title?: string;
    busy: boolean;
    expanded?: boolean;
    onClick: () => void;
}) {
    const style =
        action.id === "refuse"
            ? RefuseButton
            : action.id === "brief"
              ? GhostButton
              : action.primary
                ? PrimaryButton
                : SecondaryButton;
    return (
        <button
            type="button"
            className={style}
            disabled={busy || action.disabled}
            title={title}
            aria-expanded={expanded}
            aria-controls={expanded == null ? undefined : briefId(item)}
            data-testid="boss-card-todo-action"
            data-act={action.id}
            data-kind={action.run.kind}
            data-primary={action.primary ? "true" : "false"}
            onClick={onClick}
        >
            {busy ? <DominoLoader className="mr-1" /> : null}
            {label}
            {action.primary ? <MoltenWave /> : null}
        </button>
    );
}

function briefId(item: ToHandleItem): string {
    return `boss-handoff-brief-${item.handoff.requestid}`;
}

// Everything the receiver would get, as the sender wrote it: shown as text, never as markup.
export function HandoffBriefView({ item, from, to }: { item: ToHandleItem; from: string; to: string }) {
    const t = useT();
    const brief = item.handoff.brief;
    const files = brief.files ?? [];
    const links = brief.links ?? [];
    return (
        <div
            id={briefId(item)}
            className="flex flex-col gap-2 rounded-4 border border-line bg-surface-2 px-2.5 py-2 text-11 text-secondary"
            data-testid="boss-card-handoff-brief"
        >
            <section>
                <h3 className="text-11 font-semibold text-primary">{t("boss.todo.handoff.briefGoal")}</h3>
                <p className="break-words whitespace-pre-wrap" data-testid="boss-card-handoff-brief-goal">
                    {brief.goal}
                </p>
            </section>
            {brief.context ? (
                <section>
                    <h3 className="text-11 font-semibold text-primary">{t("boss.todo.handoff.briefContext")}</h3>
                    <p
                        className="max-h-40 overflow-y-auto break-words whitespace-pre-wrap"
                        data-testid="boss-card-handoff-brief-context"
                    >
                        {brief.context}
                    </p>
                </section>
            ) : null}
            {files.length > 0 ? (
                <section>
                    <h3 className="text-11 font-semibold text-primary">{t("boss.todo.handoff.briefFiles")}</h3>
                    <ul className="flex flex-col gap-1" data-testid="boss-card-handoff-brief-files">
                        {files.map((file, i) => (
                            <li key={`${file.path}:${i}`} className="break-words">
                                <span className="font-mono text-primary">{file.path}</span>
                                {file.lines ? (
                                    <span> {t("boss.todo.handoff.briefLines", { lines: file.lines })}</span>
                                ) : null}
                                {file.note ? <div className="whitespace-pre-wrap">{file.note}</div> : null}
                                {file.excerpt ? (
                                    <pre className="mt-0.5 max-h-24 overflow-y-auto rounded-4 bg-surface-3 px-1.5 py-1 font-mono whitespace-pre-wrap">
                                        {file.excerpt}
                                    </pre>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
            {links.length > 0 ? (
                <section>
                    <h3 className="text-11 font-semibold text-primary">{t("boss.todo.handoff.briefLinks")}</h3>
                    <ul className="flex flex-col gap-1" data-testid="boss-card-handoff-brief-links">
                        {links.map((link, i) => (
                            <li key={`${link.url}:${i}`} className="break-words">
                                <span className="text-primary">{link.title || link.url}</span>
                                {link.title && link.url ? <span className="font-mono"> {link.url}</span> : null}
                                {link.note ? <div className="whitespace-pre-wrap">{link.note}</div> : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
            <div data-testid="boss-card-handoff-brief-reply">
                {brief.reply ? t("boss.todo.handoff.replyYes", { from, to }) : t("boss.todo.handoff.replyNo")}
            </div>
        </div>
    );
}

// What the sender attached, named: the files first, then the links.
function attachedNames(row: HandoffRow): string[] {
    return [...row.files.map((file) => file.name), ...row.links.map((link) => link.name)].filter((name) => name !== "");
}

export function HandoffRowView({
    item,
    busyId,
    onRun,
    end,
}: {
    item: ToHandleItem;
    busyId: string;
    onRun: (item: ToHandleItem, action: ToHandleAction) => void;
    // What the card's action line ends with (its Archive, #2195).
    end?: ReactNode;
}) {
    const t = useT();
    const tCount = useTCount();
    const [open, setOpen] = useState(false);
    const row = item.handoff;
    const terminal = t("boss.todo.handoff.terminal");
    const from = row.from || terminal;
    const to = row.to || terminal;
    const names = attachedNames(row);
    const shown = names.slice(0, HandoffNamesLimit).join(", ");
    const attached =
        names.length > HandoffNamesLimit
            ? `${shown} ${tCount("boss.peek.more", names.length - HandoffNamesLimit)}`
            : shown;
    const parts = [
        row.files.length > 0 ? tCount("boss.todo.handoff.files", row.files.length) : "",
        row.links.length > 0 ? tCount("boss.todo.handoff.links", row.links.length) : "",
    ].filter((part) => part !== "");
    const sees =
        parts.length === 0
            ? t("boss.todo.handoff.seesBare", { to })
            : t("boss.todo.handoff.sees", {
                  to,
                  attached:
                      parts.length === 2 ? t("boss.todo.handoff.both", { files: parts[0], links: parts[1] }) : parts[0],
              });
    const titles: Record<string, string> = {
        always: t("boss.todo.handoff.alwaysTitle", { from, to }),
        refuse: t("boss.todo.handoff.refuseTitle", { from, to }),
    };
    return (
        <div
            className="flex min-w-0 flex-col"
            data-testid="boss-card-handoff"
            data-todo={item.key}
            data-tone={item.tone}
            data-handoff={row.requestid}
        >
            <div className="mt-brokk-rt flex min-w-0 flex-col gap-1.5">
                <div
                    className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
                    data-testid="boss-card-handoff-parties"
                >
                    <Party name={from} place={workspaceShownName(row.fromPlace, t)} testId="boss-card-handoff-from" />
                    <span className="text-12 text-muted" aria-hidden>
                        →
                    </span>
                    <Party name={to} place={workspaceShownName(row.toPlace, t)} testId="boss-card-handoff-to" />
                </div>
                <div className="flex min-w-0 flex-col gap-1 rounded-4 border-l-2 border-accent bg-surface-2 px-2.5 py-1.5">
                    <div className="text-12 break-words text-primary" data-testid="boss-card-handoff-goal">
                        {t("boss.todo.handoff.goal", { goal: row.goal })}
                    </div>
                    {attached ? (
                        <div className="text-11 break-words text-muted" data-testid="boss-card-handoff-attached">
                            {t("boss.todo.handoff.attached", { list: attached })}
                        </div>
                    ) : null}
                </div>
                <div className="text-11 font-normal break-words text-secondary" data-testid="boss-card-handoff-sees">
                    {sees}
                </div>
            </div>
            <div className="mt-brokk-ra" data-testid="brokk-card-actions">
                {item.actions.map((action) => {
                    if (action.run.kind === "brief") {
                        return (
                            <HandoffButton
                                key={action.id}
                                item={item}
                                action={action}
                                label={t(open ? "boss.todo.handoff.hideBrief" : action.labelKey)}
                                busy={false}
                                expanded={open}
                                onClick={() => setOpen(!open)}
                            />
                        );
                    }
                    return (
                        <HandoffButton
                            key={action.id}
                            item={item}
                            action={action}
                            label={t(action.labelKey, action.labelVars)}
                            title={titles[action.id]}
                            busy={busyId === `${item.key}|${action.id}`}
                            onClick={() => onRun(item, action)}
                        />
                    );
                })}
                <span className="mt-brokk-ra-end">{end}</span>
            </div>
            {open ? <HandoffBriefView item={item} from={from} to={to} /> : null}
        </div>
    );
}
