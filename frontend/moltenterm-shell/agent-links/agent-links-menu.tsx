// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The connections icon of a terminal's header and its menu (FR-CONT-022): the agents of the terminal and, per agent,
// every MoltenTerm connection with its state and action; then the terminal's handoffs and the site permissions of the
// agents. Only narrowing actions and the developer's explicit answers: Stop, Revoke, Unblock and typing into the
// agent ask first, nothing is approved without a click.

import { getSettingsKeyAtom } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { answerAgentHandoff } from "../agent-handoff";
import { AgentInfoModel } from "../agent-info/agent-info-store";
import { AgentStates } from "../agent-state-store";
import { setAgentSite } from "../browser/browser-agent";
import { AgentInputs } from "../command-panel/agent-input-store";
import { getLocale, useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MenuPopover } from "../mission/menu-popover";
import { MoltenWave } from "../molten-button";
import { MoltentermNotifications } from "../notifications-store";
import { SidebarModel } from "../sidebar/sidebar-store";
import { TabActivity, whileShown } from "../tab-activity";
import { termupdateMessage } from "../termupdate/termupdate-text";
import {
    addServerHint,
    agentCallName,
    AgentLinkInfo,
    agentLinkRows,
    agentTitle,
    BlockLinks,
    headerBadge,
    LinkAction,
    linkActions,
    LinkRow,
    linkStateKey,
    needsAgentStep,
    openRequestFor,
    PairEntry,
    PairsResult,
    PendingEntry,
    repairHint,
    showLinksIcon,
    siteEntries,
    versionNoteKey,
    waitingHandoffs,
} from "./agent-links-model";
import { AgentLinks } from "./agent-links-store";

const PairsPollMs = 3000;

const SecondaryClass =
    "molten-btn-secondary inline-flex h-6 cursor-pointer items-center rounded-6 px-2 text-12 disabled:cursor-default disabled:opacity-50";
const PrimaryClass = "molten-btn inline-flex h-6 cursor-pointer items-center rounded-6 px-2 text-12";

// The time a state began: the hour today, the date and hour before.
function clockTime(ms: number, now: number): string {
    const d = new Date(ms);
    const sameDay = new Date(now).toDateString() === d.toDateString();
    const hour = d.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
    return sameDay ? hour : `${d.toLocaleDateString(getLocale(), { day: "numeric", month: "short" })} ${hour}`;
}

type Confirm = { id: string; question: string; label: string; run: () => Promise<void> };

function ConfirmBox({
    confirm,
    busy,
    onCancel,
    onConfirm,
}: {
    confirm: Confirm;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const t = useT();
    const cancelRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        cancelRef.current?.focus();
    }, []);
    return (
        <div
            role="alertdialog"
            aria-label={confirm.question}
            className="mt-1 flex flex-wrap items-center gap-2 rounded-6 border border-warning/40 bg-warning/10 px-2 py-1.5"
            onKeyDown={(e) => {
                if (e.key === "Escape" && !busy) {
                    e.stopPropagation();
                    onCancel();
                }
            }}
            data-testid="agent-links-confirm"
        >
            <span className="min-w-0 flex-1 text-12 text-primary">{confirm.question}</span>
            <button ref={cancelRef} type="button" className={SecondaryClass} onClick={onCancel} disabled={busy}>
                {t("common.cancel")}
            </button>
            <button
                type="button"
                className={PrimaryClass}
                onClick={onConfirm}
                disabled={busy}
                data-testid="agent-links-confirm-go"
            >
                {confirm.label}
                <MoltenWave />
            </button>
        </div>
    );
}

function StateDot({ tone }: { tone: "ok" | "warn" | "error" | "muted" }) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                "inline-block h-2 w-2 shrink-0 rounded-full",
                tone === "ok" && "bg-success",
                tone === "warn" && "bg-warning",
                tone === "error" && "bg-error",
                tone === "muted" && "bg-secondary"
            )}
        />
    );
}

function rowTone(row: LinkRow): "ok" | "warn" | "error" | "muted" {
    if (row.notStarted) {
        return "muted";
    }
    switch (row.link.state) {
        case "connected":
            return row.link.outdated && row.link.updateblocked ? "warn" : "ok";
        case "reconnecting":
            return "warn";
        case "broken":
            return "error";
        case "legacy":
            return "warn";
    }
    return "muted";
}

type MenuProps = {
    blockId: string;
    links: BlockLinks;
    pairs: PairsResult;
    sites: Record<string, string>;
    now: number;
    confirm: Confirm;
    busy: boolean;
    error: string;
    note: string;
    ask: (c: Confirm) => void;
    run: (fn: () => Promise<void>) => void;
    onCancel: () => void;
    onConfirm: () => void;
};

function LinkRowView({ row, agent, props }: { row: LinkRow; agent: AgentLinkInfo; props: MenuProps }) {
    const t = useT();
    const { blockId, now, confirm } = props;
    const link = row.link;
    const name = agentCallName(agent) || t("agentLinks.thisAgent");
    const actions = linkActions(link);
    const hint = needsAgentStep(row) ? repairHint(agent.agent, !!agent.main) : null;
    const add = row.notStarted && link.server === "molten-browser" ? addServerHint(agent.agent) : null;
    const versionKey = versionNoteKey(link);
    const confirmId = `${agent.pid ?? ""}:${link.key}`;
    const control = (action: LinkAction) => {
        if (action === "reconnect") {
            props.run(() => AgentLinks.getInstance().control(blockId, link.key, "reconnect"));
            return;
        }
        props.ask({
            id: confirmId,
            question: t("agentLinks.confirm.stop", { name, server: link.server }),
            label: t("agentLinks.action.stop"),
            run: () => AgentLinks.getInstance().control(blockId, link.key, "stop"),
        });
    };
    const typeMcp = () =>
        props.ask({
            id: confirmId,
            question: t("agentLinks.confirm.typeMcp", { name }),
            label: t("agentLinks.action.typeMcp"),
            run: async () => {
                const result = await AgentInputs.getInstance().send({
                    blockid: blockId,
                    agent: agent.agent,
                    action: "mcp",
                });
                if (result?.result !== "sent") {
                    throw new Error(result ? termupdateMessage(result) : t("agentLinks.typeFailed"));
                }
            },
        });
    return (
        <div className="py-1" data-testid="agent-links-link" data-state={row.notStarted ? "notstarted" : link.state}>
            <div className="flex min-w-0 items-center gap-2">
                <StateDot tone={rowTone(row)} />
                <span className="min-w-0 flex-1 truncate font-mono text-12 text-primary">{link.server}</span>
                {actions.map((action) => (
                    <button
                        key={action}
                        type="button"
                        className={SecondaryClass}
                        onClick={() => control(action)}
                        disabled={props.busy}
                        data-testid={`agent-links-${action}`}
                    >
                        {t(`agentLinks.action.${action}`)}
                    </button>
                ))}
            </div>
            <div className="pl-4 text-12 text-secondary" data-testid="agent-links-state">
                {row.notStarted
                    ? t("agentLinks.state.notstarted")
                    : t(linkStateKey(link), { time: link.since ? clockTime(link.since, now) : "" })}
            </div>
            {versionKey ? (
                <div className="pl-4 text-11 text-secondary">
                    {t(versionKey, {
                        version: link.version || "?",
                        current: props.links?.version || "?",
                        reason: link.updateblocked ?? "",
                    })}
                </div>
            ) : null}
            {link.failed > 0 ? (
                <div className="pl-4 text-11 text-secondary">
                    {t("agentLinks.failed", { count: String(link.failed) })}
                    {link.lasterror ? <span className="text-muted"> {link.lasterror}</span> : null}
                </div>
            ) : null}
            {hint ? (
                <div className="flex flex-wrap items-center gap-2 pl-4 text-11 text-secondary">
                    <span className="min-w-0 flex-1">{t(hint.key, { name })}</span>
                    {hint.typeMcp ? (
                        <button
                            type="button"
                            className={SecondaryClass}
                            onClick={typeMcp}
                            disabled={props.busy}
                            data-testid="agent-links-typemcp"
                        >
                            {t("agentLinks.action.typeMcp")}
                        </button>
                    ) : null}
                </div>
            ) : null}
            {add ? (
                <div className="pl-4 text-11 text-secondary">
                    {t(add.key)} <code className="select-text font-mono text-primary">{add.command}</code>
                </div>
            ) : null}
            {confirm?.id === confirmId ? (
                <ConfirmBox confirm={confirm} busy={props.busy} onCancel={props.onCancel} onConfirm={props.onConfirm} />
            ) : null}
        </div>
    );
}

function AgentSection({ agent, props }: { agent: AgentLinkInfo; props: MenuProps }) {
    const t = useT();
    return (
        <section className="border-b border-border pb-2 last:border-b-0" data-testid="agent-links-agent">
            <div className="flex items-baseline gap-2">
                <span className="truncate text-13 font-medium text-primary">
                    {agentTitle(agent) || t("agentLinks.thisAgent")}
                </span>
                {!agent.main ? (
                    <span className="shrink-0 text-11 text-secondary">{t("agentLinks.otherAgent")}</span>
                ) : null}
            </div>
            {agentLinkRows(agent).map((row) => (
                <LinkRowView key={row.link.key} row={row} agent={agent} props={props} />
            ))}
        </section>
    );
}

function decisionKey(decision: string): string {
    if (decision === "always") {
        return "agentLinks.pair.always";
    }
    if (decision === "block") {
        return "agentLinks.pair.block";
    }
    return "agentLinks.pair.ask";
}

function PairRow({ entry, props }: { entry: PairEntry; props: MenuProps }) {
    const t = useT();
    const name = entry.firstname || entry.agentname || t("agentLinks.endedAgent");
    const confirmId = `pair:${entry.blockid}`;
    const forget = () =>
        props.ask({
            id: confirmId,
            question: t(entry.decision === "block" ? "agentLinks.confirm.unblock" : "agentLinks.confirm.revoke", {
                name,
            }),
            label: t(entry.decision === "block" ? "agentLinks.action.unblock" : "agentLinks.action.revoke"),
            run: () => AgentLinks.getInstance().forgetPair(props.blockId, entry.blockid),
        });
    return (
        <div className="py-0.5" data-testid="agent-links-pair" data-decision={entry.decision || "ask"}>
            <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-12 text-primary">
                    {name}
                    {entry.agentname && entry.firstname ? (
                        <span className="text-secondary"> · {entry.agentname}</span>
                    ) : null}
                </span>
                <span className="shrink-0 text-12 text-secondary">{t(decisionKey(entry.decision))}</span>
                {entry.decision ? (
                    <button
                        type="button"
                        className={SecondaryClass}
                        onClick={forget}
                        disabled={props.busy}
                        data-testid="agent-links-forget"
                    >
                        {t(entry.decision === "block" ? "agentLinks.action.unblock" : "agentLinks.action.revoke")}
                    </button>
                ) : null}
            </div>
            {props.confirm?.id === confirmId ? (
                <ConfirmBox
                    confirm={props.confirm}
                    busy={props.busy}
                    onCancel={props.onCancel}
                    onConfirm={props.onConfirm}
                />
            ) : null}
        </div>
    );
}

function PendingRow({ entry, props }: { entry: PendingEntry; props: MenuProps }) {
    const t = useT();
    const answer = (decision: "once" | "always" | "block") =>
        props.run(async () => {
            const result = await answerAgentHandoff({ requestid: entry.requestid, decision });
            if (!result.ok) {
                throw new Error(result.error);
            }
            // The notification asked the same question: it closes with the answer.
            MoltentermNotifications.getInstance().resolve(`agenthandoff:${entry.requestid}`);
        });
    return (
        <div className="rounded-6 border border-accent/40 bg-accent/10 px-2 py-1.5" data-testid="agent-links-pending">
            <div className="text-12 text-primary">
                {entry.from
                    ? t("agentLinks.pending.title", { from: entry.from, to: entry.to })
                    : t("agentLinks.pending.titleTerminal", { to: entry.to })}
            </div>
            {entry.goal ? <div className="truncate text-11 text-secondary">{entry.goal}</div> : null}
            <div className="mt-1 flex flex-wrap gap-2">
                <button
                    type="button"
                    className={PrimaryClass}
                    onClick={() => answer("once")}
                    disabled={props.busy}
                    data-testid="agent-links-allow-once"
                >
                    {t("agentLinks.pending.once")}
                    <MoltenWave />
                </button>
                <button
                    type="button"
                    className={SecondaryClass}
                    onClick={() => answer("always")}
                    disabled={props.busy}
                    data-testid="agent-links-allow-always"
                >
                    {t("agentLinks.pending.always")}
                </button>
                <button
                    type="button"
                    className={SecondaryClass}
                    onClick={() => answer("block")}
                    disabled={props.busy}
                    data-testid="agent-links-block"
                >
                    {t("agentLinks.pending.block")}
                </button>
            </div>
        </div>
    );
}

function SiteRows({ props }: { props: MenuProps }) {
    const t = useT();
    const entries = siteEntries(props.sites);
    if (entries.length === 0) {
        return <div className="text-12 text-secondary">{t("agentLinks.sites.none")}</div>;
    }
    return (
        <>
            {entries.map((entry) => {
                const confirmId = `site:${entry.site}`;
                return (
                    <div key={entry.site} className="py-0.5" data-testid="agent-links-site">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-12 text-primary">{entry.site}</span>
                            <span className="shrink-0 text-12 text-secondary">
                                {t(
                                    entry.decision === "allow" ? "agentLinks.sites.allowed" : "agentLinks.sites.blocked"
                                )}
                            </span>
                            <button
                                type="button"
                                className={SecondaryClass}
                                disabled={props.busy}
                                onClick={() =>
                                    props.ask({
                                        id: confirmId,
                                        question: t("agentLinks.confirm.site", { site: entry.site }),
                                        label: t("agentLinks.action.forgetSite"),
                                        run: () => setAgentSite(entry.site, ""),
                                    })
                                }
                                data-testid="agent-links-site-forget"
                            >
                                {t("agentLinks.action.forgetSite")}
                            </button>
                        </div>
                        {props.confirm?.id === confirmId ? (
                            <ConfirmBox
                                confirm={props.confirm}
                                busy={props.busy}
                                onCancel={props.onCancel}
                                onConfirm={props.onConfirm}
                            />
                        ) : null}
                    </div>
                );
            })}
        </>
    );
}

function LinksMenuBody(props: MenuProps) {
    const t = useT();
    const agents = props.links?.agents ?? [];
    const pending = props.pairs?.pending ?? [];
    const pairs = props.pairs?.agents ?? [];
    return (
        <div className="flex w-[380px] max-w-full flex-col gap-3" data-testid="agent-links-menu">
            <div>
                <div className="text-13 font-semibold text-primary">{t("agentLinks.title")}</div>
                <div className="text-11 text-secondary">{t("agentLinks.subtitle")}</div>
            </div>
            {props.error ? (
                <div className="text-12 text-danger" role="alert">
                    {props.error}
                </div>
            ) : null}
            {props.note ? <div className="text-12 text-secondary">{props.note}</div> : null}
            {agents.length === 0 ? <div className="text-12 text-secondary">{t("agentLinks.noAgent")}</div> : null}
            {agents.map((agent, idx) => (
                <AgentSection key={`${agent.pid ?? 0}:${idx}`} agent={agent} props={props} />
            ))}
            <section className="flex flex-col gap-1">
                <div className="text-12 font-medium text-primary">{t("agentLinks.handoffs.title")}</div>
                {pending.map((entry) => (
                    <PendingRow key={entry.requestid} entry={entry} props={props} />
                ))}
                {pairs.length === 0 ? (
                    <div className="text-12 text-secondary">{t("agentLinks.handoffs.none")}</div>
                ) : null}
                {pairs.map((entry) => (
                    <PairRow key={entry.blockid} entry={entry} props={props} />
                ))}
            </section>
            <section className="flex flex-col gap-1">
                <div className="text-12 font-medium text-primary">{t("agentLinks.sites.title")}</div>
                <SiteRows props={props} />
            </section>
        </div>
    );
}

// The menu's state and actions, shared by the header's popover and the agent window's Connections (FR-SHELL-084).
function useLinksMenuProps(blockId: string): MenuProps {
    const links = useAtomValue(AgentLinks.getInstance().blockAtom(blockId));
    const sites = useAtomValue(getSettingsKeyAtom("browser:agentsites")) as Record<string, string>;
    const [pairs, setPairs] = useState<PairsResult>(null);
    const [confirm, setConfirm] = useState<Confirm>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [now, setNow] = useState(Date.now());

    // The open menu reads the links and the pairs again: a server's process may end after its link went down.
    const loadPairs = useCallback(() => {
        fireAndForget(async () => {
            try {
                await AgentLinks.getInstance().refresh(blockId);
                setPairs(await AgentLinks.getInstance().pairs(blockId));
            } catch (e) {
                console.log("agent links: refresh", e);
            }
        });
    }, [blockId]);

    useEffect(() => {
        loadPairs();
        return TabActivity.getInstance().every(
            whileShown(PairsPollMs),
            () => {
                loadPairs();
                setNow(Date.now());
            },
            "agent-links-pairs"
        );
    }, [blockId, loadPairs]);

    const run = (fn: () => Promise<void>) => {
        setBusy(true);
        setError("");
        fireAndForget(async () => {
            try {
                await fn();
                setConfirm(null);
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setBusy(false);
                loadPairs();
            }
        });
    };

    return {
        blockId,
        links,
        pairs,
        sites,
        now,
        confirm,
        busy,
        error,
        note: "",
        ask: (c) => {
            setError("");
            setConfirm(c);
        },
        run,
        onCancel: () => setConfirm(null),
        onConfirm: () => confirm && run(confirm.run),
    };
}

function LinksMenu({ blockId, anchor, onClose }: { blockId: string; anchor: Element; onClose: () => void }) {
    const t = useT();
    const props = useLinksMenuProps(blockId);
    return (
        <MenuPopover
            anchor={anchor}
            onClose={onClose}
            placement="bottom-end"
            role="dialog"
            ariaLabel={t("agentLinks.title")}
        >
            <LinksMenuBody {...props} />
        </MenuPopover>
    );
}

// The same connections, shown in the agent window (FR-SHELL-084): its MCP links, handoff decisions and sites.
export function AgentLinksPanel({ blockId }: { blockId: string }) {
    const props = useLinksMenuProps(blockId);
    return <LinksMenuBody {...props} />;
}

// The 4th header icon (beside the command panel trigger, magnify and close): on a terminal holding an agent or a
// MoltenTerm MCP link, with the worst state as its badge.
export const AgentLinksHeaderButton = memo(({ blockId, termHeader }: { blockId: string; termHeader: boolean }) => {
    const t = useT();
    const store = AgentLinks.getInstance();
    const links = useAtomValue(store.blockAtom(termHeader ? blockId : null));
    const agent = useAtomValue(AgentStates.getInstance().blockAtom(termHeader ? blockId : null));
    const notifications = useAtomValue(MoltentermNotifications.getInstance().entriesAtom);
    const openRequest = useAtomValue(store.openRequestAtom);
    const sidebarOn = useAtomValue(SidebarModel.getInstance().enabledAtom);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const visible = termHeader && showLinksIcon(agent != null, links);

    useEffect(() => {
        if (!visible || !openRequestFor(openRequest, blockId, Date.now())) {
            return;
        }
        store.clearOpenRequest();
        setOpen(true);
    }, [visible, openRequest, blockId]);

    if (!visible) {
        return null;
    }
    const badge = headerBadge(links, waitingHandoffs(notifications, blockId));
    const status = t(badge ? `agentLinks.icon.${badge}` : "agentLinks.icon.ok");
    const title =
        agent != null && sidebarOn
            ? `${t("agentInfo.plugTitle", { name: agent.firstname || agent.agentname || agent.agent })}\n${status}`
            : status;
    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                className="wave-iconbutton relative cursor-pointer"
                title={title}
                aria-label={title}
                aria-haspopup="dialog"
                aria-expanded={open}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                    e.stopPropagation();
                    // Under the workspace sidebar the plug opens everything about the agent (FR-SHELL-084), whose
                    // Connections keep this menu; a terminal without a detected agent keeps the menu itself.
                    if (agent != null && sidebarOn) {
                        AgentInfoModel.getInstance().open(blockId);
                        return;
                    }
                    setOpen(!open);
                }}
                data-testid="agent-links-button"
                data-badge={badge ?? "none"}
            >
                <i className="fa fa-solid fa-plug" />
                {badge ? (
                    <span
                        aria-hidden="true"
                        className={cn(
                            "absolute top-0 right-0 h-1.5 w-1.5 rounded-full",
                            badge === "broken" ? "bg-error" : "bg-accent"
                        )}
                    />
                ) : null}
            </button>
            {open && buttonRef.current ? (
                <LinksMenu blockId={blockId} anchor={buttonRef.current} onClose={() => setOpen(false)} />
            ) : null}
        </>
    );
});
AgentLinksHeaderButton.displayName = "AgentLinksHeaderButton";
