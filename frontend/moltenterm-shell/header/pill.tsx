// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The one Pill of MoltenTerm's headers (FR-SHELL-052, DS-SHELL-093): 20 px high, radius 6, 11/500, tones neutral,
// warning and danger, an optional 6 px dot and an optional trailing action. It replaces the header's label styles
// (agent label, tree chip, offers, the durable shield). The header is the panel's drag handle: the pill's buttons
// keep the pointer to themselves.

import { cn, makeIconClass } from "@/util/util";
import type { MouseEvent } from "react";
import type { PillTone } from "./header-model";
import "./header.css";

export type PillProps = {
    label: string;
    tone?: PillTone;
    title?: string;
    dot?: boolean;
    icon?: string;
    // The whole pill as a button (open the session options, stop multi input).
    onClick?: () => void;
    // A trailing action ("Go"), its own button.
    action?: string;
    actionLabel?: string;
    onAction?: () => void;
    className?: string;
    testId?: string;
};

function stop(e: MouseEvent) {
    e.stopPropagation();
}

export function Pill({
    label,
    tone = "neutral",
    title,
    dot,
    icon,
    onClick,
    action,
    actionLabel,
    onAction,
    className,
    testId,
}: PillProps) {
    const classes = cn("molten-pill", tone !== "neutral" && `is-${tone}`, className);
    const body = (
        <>
            {dot ? <span className="molten-pill-dot" aria-hidden /> : null}
            {icon ? <i className={cn(makeIconClass(icon, false), "molten-pill-icon")} aria-hidden /> : null}
            <span className="molten-pill-label">{label}</span>
        </>
    );
    if (onClick != null && action == null) {
        return (
            <button
                type="button"
                className={classes}
                title={title}
                onMouseDown={stop}
                onClick={(e) => {
                    e.stopPropagation();
                    onClick();
                }}
                data-testid={testId}
                data-tone={tone}
            >
                {body}
            </button>
        );
    }
    return (
        <span
            className={classes}
            title={title}
            data-testid={testId}
            data-tone={tone}
            role={tone === "neutral" ? undefined : "status"}
        >
            {body}
            {action ? (
                <button
                    type="button"
                    className="molten-pill-action"
                    aria-label={actionLabel ?? action}
                    title={actionLabel ?? action}
                    onMouseDown={stop}
                    onClick={(e) => {
                        e.stopPropagation();
                        onAction?.();
                    }}
                >
                    {action}
                </button>
            ) : null}
        </span>
    );
}
