// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How much an agent has been tried with MoltenTerm (FR-AGC-004, #2167): the chip on the agent's card, whose tooltip says
// what the level means and offers Report a problem. The chip is a button so that the keyboard reaches it: hovering or
// focusing it opens the tooltip, and Tab goes on to its link. Showing it reads data only; the link opens a page in the
// browser panel when the user clicks it, nothing else.

import { fireAndForget } from "@/util/util";
import {
    autoUpdate,
    flip,
    FloatingFocusManager,
    FloatingPortal,
    offset,
    safePolygon,
    shift,
    useDismiss,
    useFocus,
    useHover,
    useInteractions,
    useRole,
} from "@floating-ui/react";
import { useState } from "react";
import { useFloatingInPlace } from "../floating-in-place";
import { useT } from "../i18n/i18n";
import { openWebLink } from "../open-web-link";
import { reportProblemUrl, triedLevelKey, triedMeaningKey, type AgentTried } from "./agent-tried-model";
import "./agent-tried.css";

// The repository's new-issue page, in the browser panel like every link of the interface (FR-BRW-006).
export async function openReportProblem(agentName: string): Promise<boolean> {
    return openWebLink(reportProblemUrl(agentName));
}

function ReportLink({ name, testId }: { name: string; testId: string }) {
    const t = useT();
    return (
        <a
            href={reportProblemUrl(name)}
            className="mt-tried-link"
            data-testid={testId}
            onClick={(e) => {
                e.preventDefault();
                fireAndForget(() => openReportProblem(name));
            }}
        >
            {t("agentTried.report")}
        </a>
    );
}

// The tooltip's content, apart from the floating surface so that it renders without a window in tests.
export function TriedTipBody({ name, tried, testId }: { name: string; tried: AgentTried; testId: string }) {
    const t = useT();
    return (
        <>
            <p data-testid={`${testId}-meaning`}>{t(triedMeaningKey(tried.level), { name })}</p>
            {tried.asof ? (
                <span className="mt-tried-asof" data-testid={`${testId}-asof`}>
                    {t("agentTried.asof", { date: tried.asof })}
                </span>
            ) : null}
            <ReportLink name={name} testId={`${testId}-report`} />
        </>
    );
}

// The level in an agent's "what works" view: the chip, with the date the level was set. plain: the level in words
// instead of the chip, where the chip already sits on the same page.
export function TriedLine({
    name,
    tried,
    className,
    plain,
}: {
    name: string;
    tried: AgentTried;
    className?: string;
    plain?: boolean;
}) {
    const t = useT();
    if (tried == null) {
        return null;
    }
    return (
        <span className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`} data-testid="agent-works-tried">
            <span className="text-muted">{t("agentTried.line")}</span>
            {plain ? (
                <b className="font-semibold" data-level={tried.level} data-testid="agent-works-tried-level">
                    {t(triedLevelKey(tried.level))}
                </b>
            ) : (
                <TriedChip name={name} tried={tried} testId="agent-works-tried-chip" />
            )}
            {tried.asof ? (
                <span className="text-muted" data-testid="agent-works-tried-asof">
                    {t("agentTried.asof", { date: tried.asof })}
                </span>
            ) : null}
        </span>
    );
}

export function TriedChip({
    name,
    tried,
    testId = "agent-tried",
    className,
}: {
    name: string;
    tried: AgentTried;
    testId?: string;
    className?: string;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const { refs, floatingStyles, context } = useFloatingInPlace({
        open,
        onOpenChange: setOpen,
        placement: "bottom-start",
        middleware: [offset(6), flip(), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    const hover = useHover(context, { move: false, delay: { open: 150, close: 80 }, handleClose: safePolygon() });
    const focus = useFocus(context);
    const dismiss = useDismiss(context);
    const role = useRole(context, { role: "tooltip" });
    const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
    if (tried == null) {
        return null;
    }
    const level = t(triedLevelKey(tried.level));
    return (
        <>
            <button
                ref={refs.setReference}
                type="button"
                className={className ? `mt-tried ${className}` : "mt-tried"}
                data-level={tried.level}
                data-testid={testId}
                aria-label={t("agentTried.chipLabel", { level, name })}
                {...getReferenceProps()}
            >
                <span className="mt-tried-pips" aria-hidden>
                    <i />
                    <i />
                    <i />
                </span>
                {level}
            </button>
            {open ? (
                <FloatingPortal>
                    <FloatingFocusManager context={context} modal={false} initialFocus={-1} returnFocus={false}>
                        <div
                            ref={refs.setFloating}
                            style={floatingStyles}
                            className="mt-tried-tip"
                            data-testid={`${testId}-tip`}
                            {...getFloatingProps()}
                        >
                            <TriedTipBody name={name} tried={tried} testId={testId} />
                        </div>
                    </FloatingFocusManager>
                </FloatingPortal>
            ) : null}
        </>
    );
}
