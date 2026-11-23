// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The main agent's permissions in the companion (FR-SHELL-018, FR-SHELL-063 AC9 to AC12, #2474): the Permissions control
// at the head of the block's tools (Ask me, approve automatically for a period, always), the Autonomous chip that says
// the session runs on its own and stops it, and the line that counts what it approved, with the list. The sentences and
// the rules are the model's (companion-permit-model.ts); the calls are the store's (companion-permit-store.ts).

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Shield, ShieldCheck } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import type { TFunction } from "../i18n/i18n";
import { useT, useTCount } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import { KeepAwakeModel } from "../keepawake-store";
import { MenuPopover } from "../mission/menu-popover";
import { durationText, sinceText } from "../reviews/reviews-upcoming-model";
import { BlockTool } from "./companion-block";
import type { CompanionView } from "./companion-model";
import {
    autonomousApprovals,
    autonomyLeftMs,
    autonomyOf,
    liveSessionId,
    modeOf,
    periodOf,
    PermitAutonomy,
    PermitMode,
    PermitModeResult,
    PermitPeriod,
    PermitPeriods,
} from "./companion-permit-model";
import { PermitModel, usePermitState, usePermitWatch, useTick } from "./companion-permit-store";
import "./companion-permit.css";
import { TipScopeAttr } from "./companion-tips-model";

// Claude Code and Codex: the agents whose hook MoltenTerm answers. Kimi's is observation-only (FR-SHELL-064).
const AnsweredAgents = new Set(["claude", "codex"]);

// What the hero shows and does for the main agent's session; null where the agent cannot be answered.
export type HeroPermit = {
    // The agent's first name.
    name: string;
    // The session can be set to approve automatically; reason says why not, worded.
    available: boolean;
    reason: string;
    autonomy: PermitAutonomy;
    now: number;
    // Sets the session's mode; resolves with what went wrong, worded, "" when it went through.
    onChoose: (mode: PermitMode, period?: PermitPeriod) => Promise<string>;
};

// The hero's permissions: the gate's state for the terminal and its live session, what wavesrv says that session can do,
// and the calls. A window that shows this says so to wavesrv, which then holds the terminal's requests for it.
export function usePermitControl(target: string, view: CompanionView, name: string): HeroPermit {
    const t = useT();
    const state = usePermitState();
    const watched = AnsweredAgents.has(view?.agent ?? "") && view?.status === "live" ? target : "";
    const watch = usePermitWatch(watched);
    const sessionId = liveSessionId(view);
    const first = autonomyOf(state, target, sessionId, Date.now());
    const now = useTick(first != null && first.mode === "for", 15_000);
    const autonomy = autonomyOf(state, target, sessionId, now);
    const known = watched !== "" && watch.blockid === watched;
    const available = known && watch.available && sessionId !== "";
    const reasonText = !known
        ? ""
        : watch.available && sessionId === ""
          ? t("companion.permit.menu.unavailablePlain")
          : watch.reason
            ? t("companion.permit.menu.unavailable", { reason: serverText(watch.reasontext, watch.reason) })
            : "";
    const onChoose = useMemo(
        () => async (mode: PermitMode, period?: PermitPeriod) => {
            try {
                return modeError(t, await PermitModel.getInstance().setMode(target, sessionId, mode, period));
            } catch (e) {
                console.log("permission gate: the choice failed", e);
                return t("companion.permit.menu.failed");
            }
        },
        [target, sessionId, t]
    );
    if (!known) {
        return null;
    }
    return { name: name || t("companion.permit.agentPlain"), available, reason: reasonText, autonomy, now, onChoose };
}

// What went wrong with a choice, worded; "" when it went through.
export function modeError(t: ReturnType<typeof useT>, result: PermitModeResult): string {
    if (result?.status === "set") {
        return "";
    }
    if (result?.status === "unavailable" && result.reason) {
        return t("companion.permit.menu.unavailable", { reason: serverText(result.reasontext, result.reason) });
    }
    return t("companion.permit.menu.failed");
}

function modeLabel(t: ReturnType<typeof useT>, permit: HeroPermit): string {
    return t(`companion.permit.mode.${modeOf(permit.autonomy)}`);
}

function periodLabel(t: ReturnType<typeof useT>, period: PermitPeriod): string {
    return t(`companion.permit.menu.period${period === "tonight" ? "Tonight" : period}`);
}

// Where "until tonight" ends, as the gate computes it (untilTonight in pkg/molten/keepawake/gate.go): the evening, or the
// morning once the evening is on.
export function tonightEnd(now: number): number {
    const at = new Date(now);
    const end = new Date(at);
    const hour = at.getHours();
    if (hour < 6) {
        end.setHours(6, 0, 0, 0);
    } else if (hour < 21) {
        end.setHours(22, 0, 0, 0);
    } else {
        end.setDate(end.getDate() + 1);
        end.setHours(6, 0, 0, 0);
    }
    return end.getTime();
}

// The tool at the head of the block's tools: a shield and what the session does, opening the menu of the choices.
export function PermissionsTool({ permit }: { permit: HeroPermit }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [said, setSaid] = useState("");
    const button = useRef<HTMLButtonElement>(null);
    const mode = modeLabel(t, permit);
    const autonomous = permit.autonomy != null;
    const choose = async (next: PermitMode, period?: PermitPeriod): Promise<string> => {
        const error = await permit.onChoose(next, period);
        if (error === "") {
            setSaid(
                next === "ask"
                    ? t("companion.permit.menu.saidAsk", { name: permit.name })
                    : next === "always"
                      ? t("companion.permit.menu.saidAlways", { name: permit.name })
                      : t("companion.permit.menu.saidFor", { name: permit.name, period: periodLabel(t, period) })
            );
        }
        return error;
    };
    return (
        <>
            <BlockTool
                label={t("companion.permit.toolLabel", { name: permit.name, mode })}
                tip={t("companion.permit.toolTip", { name: permit.name })}
                buttonRef={button}
                opens={{ open }}
                onClick={() => setOpen(!open)}
                testId="companion-permit-tool"
                className={cn("mt-cdash-perm-tool", autonomous && "mt-cdash-perm-tool-on")}
            >
                <Shield size={14} aria-hidden="true" />
                <span className="mt-cdash-perm-tool-text">{t("companion.permit.tool", { mode })}</span>
                <i className="fa fa-solid fa-chevron-down fa-2xs mt-cdash-perm-chevron" aria-hidden="true" />
            </BlockTool>
            <span role="status" aria-live="polite" className="sr-only" data-testid="companion-permit-said">
                {said}
            </span>
            {open && button.current != null ? (
                <MenuPopover
                    anchor={button.current}
                    onClose={() => setOpen(false)}
                    placement="bottom-end"
                    role="dialog"
                    ariaLabel={t("companion.permit.menu.dialog", { name: permit.name })}
                    className="mt-cb-settings mt-cdash-perm-menu"
                    focusManaged
                >
                    <PermissionsMenuHost permit={permit} onChoose={choose} onDone={() => setOpen(false)} />
                </MenuPopover>
            ) : null}
        </>
    );
}

// A choice goes through at once and closes the menu; what went wrong stays in it.
function PermissionsMenuHost({
    permit,
    onChoose,
    onDone,
}: {
    permit: HeroPermit;
    onChoose: (mode: PermitMode, period?: PermitPeriod) => Promise<string>;
    onDone: () => void;
}) {
    const t = useT();
    const titleId = useId();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const pick = async (next: PermitMode, chosen?: PermitPeriod) => {
        setBusy(true);
        setError("");
        const failed = await onChoose(next, chosen);
        setBusy(false);
        if (failed) {
            setError(failed);
            return;
        }
        onDone();
    };
    return (
        <PermissionsMenu
            permit={permit}
            t={t}
            titleId={titleId}
            busy={busy}
            error={error}
            onPick={pick}
            onDone={onDone}
        />
    );
}

// The menu: a row for each way the session answers its agent's requests. What cannot be chosen says why, and Ask me
// always can. Hook-free, so it is read without a window.
export function PermissionsMenu({
    permit,
    t,
    titleId,
    busy,
    error,
    onPick,
    onDone,
}: {
    permit: HeroPermit;
    t: TFunction;
    titleId: string;
    busy?: boolean;
    error?: string;
    onPick: (mode: PermitMode, period?: PermitPeriod) => void;
    onDone: () => void;
}) {
    const mode = modeOf(permit.autonomy);
    const period = periodOf(permit.autonomy);
    const off = !permit.available;
    const pick = onPick;
    return (
        <div
            className="mt-cb-settings-body mt-perm-menu"
            role="group"
            aria-labelledby={titleId}
            {...{ [TipScopeAttr]: "" }}
            data-testid="companion-permit-menu"
            onKeyDown={(e) => {
                if (e.key !== "Escape") {
                    return;
                }
                e.stopPropagation();
                onDone();
            }}
        >
            <h4 id={titleId} className="mt-cb-settings-title">
                {t("companion.permit.menu.title", { name: permit.name })}
            </h4>
            <button
                type="button"
                className="mt-perm-row"
                aria-pressed={mode === "ask"}
                disabled={busy}
                data-testid="companion-permit-ask"
                onClick={() => pick("ask")}
            >
                <span className="mt-perm-radio" data-on={mode === "ask" ? "" : undefined} aria-hidden="true" />
                <span className="mt-perm-text">
                    <span className="mt-perm-label">{t("companion.permit.menu.ask")}</span>
                    <span className="mt-perm-sub">{t("companion.permit.menu.askSub")}</span>
                </span>
            </button>
            <div className="mt-perm-row mt-perm-row-group" aria-disabled={off || undefined}>
                <span className="mt-perm-radio" data-on={mode === "for" ? "" : undefined} aria-hidden="true" />
                <span className="mt-perm-text">
                    <span className="mt-perm-label">{t("companion.permit.menu.for")}</span>
                    <span className="mt-perm-chips" role="group" aria-label={t("companion.permit.menu.periods")}>
                        {PermitPeriods.map((p) => (
                            <button
                                key={p}
                                type="button"
                                className="mt-perm-chip"
                                aria-pressed={mode === "for" && period === p}
                                disabled={off || busy}
                                data-tip={
                                    p === "tonight"
                                        ? t("companion.permit.menu.until", {
                                              time: sinceText(tonightEnd(permit.now), permit.now),
                                          })
                                        : undefined
                                }
                                data-testid={`companion-permit-period-${p}`}
                                onClick={() => pick("for", p)}
                            >
                                {periodLabel(t, p)}
                            </button>
                        ))}
                    </span>
                </span>
            </div>
            <button
                type="button"
                className="mt-perm-row"
                aria-pressed={mode === "always"}
                disabled={off || busy}
                data-testid="companion-permit-always"
                onClick={() => pick("always")}
            >
                <span className="mt-perm-radio" data-on={mode === "always" ? "" : undefined} aria-hidden="true" />
                <span className="mt-perm-text">
                    <span className="mt-perm-label">{t("companion.permit.menu.always")}</span>
                    <span className="mt-perm-sub">{t("companion.permit.menu.alwaysSub", { name: permit.name })}</span>
                </span>
            </button>
            <p className="mt-perm-foot">{t("companion.permit.menu.foot")}</p>
            {off && permit.reason ? (
                <p className="mt-perm-foot" data-testid="companion-permit-unavailable">
                    {permit.reason}
                </p>
            ) : null}
            {error ? (
                <p className="mt-perm-foot mt-perm-error" role="alert" data-testid="companion-permit-menu-error">
                    {error}
                </p>
            ) : null}
        </div>
    );
}

// The header chip while the session runs on its own: how long it still does, and the one click that stops it. Under
// reduced motion nothing here moves.
export function AutonomousChip({ permit }: { permit: HeroPermit }) {
    const t = useT();
    const [busy, setBusy] = useState(false);
    const stop = async () => {
        setBusy(true);
        await permit.onChoose("ask");
        setBusy(false);
    };
    return <AutonomousChipView permit={permit} t={t} busy={busy} onStop={stop} />;
}

// Hook-free, so it is read without a window.
export function AutonomousChipView({
    permit,
    t,
    busy,
    onStop,
}: {
    permit: HeroPermit;
    t: TFunction;
    busy?: boolean;
    onStop: () => void;
}) {
    const autonomy = permit.autonomy;
    if (autonomy == null) {
        return null;
    }
    const left = autonomyLeftMs(autonomy, permit.now);
    const text =
        left == null
            ? t("companion.permit.chip.always")
            : t("companion.permit.chip.for", { time: durationText(t, left) });
    return (
        <span className="mt-cb-chip mt-cb-chip-off mt-cdash-auto-chip" data-testid="companion-autonomous-chip">
            <ShieldCheck size={13} aria-hidden="true" />
            <span className="mt-cdash-auto-text" role="status" aria-label={t("companion.permit.chip.label")}>
                {text}
            </span>
            <button
                type="button"
                className="mt-cdash-auto-stop"
                disabled={busy}
                aria-label={t("companion.permit.chip.stopLabel", { name: permit.name })}
                data-testid="companion-autonomous-stop"
                onClick={(e) => {
                    e.stopPropagation();
                    onStop();
                }}
            >
                {t("companion.permit.chip.stop")}
            </button>
        </span>
    );
}

// The line under the hero's subject while the session runs on its own: what it approved since the developer set it, and
// the list. The list is read from the coffee approvals' log in the state, and only once it is opened.
export function AutonomyLine({ permit }: { permit: HeroPermit }) {
    const t = useT();
    const tCount = useTCount();
    const [open, setOpen] = useState(false);
    const listId = useId();
    const autonomy = permit.autonomy;
    if (autonomy == null) {
        return null;
    }
    const since = sinceText(autonomy.since, permit.now);
    const text =
        autonomy.approved > 0
            ? tCount("companion.permit.approved", autonomy.approved, { count: autonomy.approved, time: since })
            : t("companion.permit.list.none", { time: since });
    return (
        <div className="mt-cdash-autoline" data-testid="companion-autoline">
            <div className="mt-cdash-autoline-row">
                <ShieldCheck size={13} aria-hidden="true" />
                <span data-testid="companion-autoline-text">{text}</span>
                {autonomy.approved > 0 ? (
                    <>
                        <span aria-hidden="true">·</span>
                        <button
                            type="button"
                            className="mt-cdash-link"
                            aria-expanded={open}
                            aria-controls={listId}
                            data-testid="companion-autoline-toggle"
                            onClick={() => setOpen(!open)}
                        >
                            {t(open ? "companion.permit.list.hide" : "companion.permit.list.show")}
                        </button>
                    </>
                ) : null}
            </div>
            {open ? <AutonomyList id={listId} autonomy={autonomy} /> : null}
        </div>
    );
}

const ListCap = 20;

function AutonomyList({ id, autonomy }: { id: string; autonomy: PermitAutonomy }) {
    const t = useT();
    const state = useAtomValue(KeepAwakeModel.getInstance().stateAtom);
    const approvals = autonomousApprovals(state, autonomy).slice(0, ListCap);
    return (
        <ul
            id={id}
            className="mt-cdash-autolist"
            aria-label={t("companion.permit.list.title")}
            data-testid="companion-autolist"
        >
            {approvals.map((a) => (
                <li key={a.id}>
                    <span className="mt-cdash-autolist-time">{sinceText(a.at, Date.now())}</span>
                    <span className="mt-cdash-autolist-tool" data-mono="">
                        {a.tool}
                    </span>
                    <span className="mt-cdash-autolist-detail" data-tip={a.detail || undefined}>
                        {a.detail}
                    </span>
                </li>
            ))}
        </ul>
    );
}
