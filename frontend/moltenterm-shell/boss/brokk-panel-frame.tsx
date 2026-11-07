// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The frame every panel of Brokk's group wears (FR-BOSS-009, AC18, #2032): a one-line header (the title and its count,
// what sits next to the title, then compact icon buttons with tooltips and the close control) and the body that scrolls
// inside. The group measures the header and the content to give the panel the height it needs (brokk-group-model.ts
// panelHeight), so both carry a data attribute for that.

import { cn, makeIconClass } from "@/util/util";
import { ReactNode } from "react";
import { useT } from "../i18n/i18n";

export const PanelHeadAttr = "data-panel-head";
export const PanelContentAttr = "data-panel-content";

// A compact icon button of a header: its label is its tooltip and its accessible name.
export function HeaderIconButton({
    icon,
    label,
    title,
    testId,
    pressed,
    disabled,
    onClick,
}: {
    icon: string;
    label: string;
    title?: string;
    testId: string;
    pressed?: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            className={cn(
                "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-11 text-secondary",
                "hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50",
                pressed && "bg-[var(--mt-action-wash)] text-[var(--mt-action-text)]"
            )}
            title={title ?? label}
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            data-testid={testId}
            onClick={onClick}
        >
            <i className={makeIconClass(icon, true)} aria-hidden />
        </button>
    );
}

export function PanelFrame({
    id,
    title,
    count,
    beside,
    actions,
    onClose,
    children,
}: {
    id: string;
    title: string;
    // The number of rows the panel lists, when it counts any.
    count?: number;
    // What sits next to the title (the Notifications panel's switch to the archive).
    beside?: ReactNode;
    // The compact icon buttons, before the close control.
    actions?: ReactNode;
    onClose: () => void;
    children: ReactNode;
}) {
    const t = useT();
    return (
        <>
            <div className="mt-brokk-gp-head" {...{ [PanelHeadAttr]: "" }}>
                <h2 className="mt-brokk-gp-title" data-testid={`brokk-panel-title-${id}`}>
                    {title}
                </h2>
                {count != null ? (
                    <span className="mt-brokk-gp-count" data-testid={`brokk-panel-count-${id}`}>
                        {count}
                    </span>
                ) : null}
                {beside}
                <span className="flex-1" />
                {actions}
                <HeaderIconButton
                    icon="xmark"
                    label={t("boss.group.closePanel")}
                    testId="brokk-panel-close"
                    onClick={onClose}
                />
            </div>
            <div className="mt-brokk-gp-scroll" data-testid={`brokk-panel-body-${id}`}>
                <div {...{ [PanelContentAttr]: "" }}>{children}</div>
            </div>
        </>
    );
}

// The line a panel ends with when a button failed.
export function PanelProblem({ problem }: { problem: string }) {
    if (!problem) {
        return null;
    }
    return (
        <div className="shrink-0 truncate px-3 py-1 text-11 text-danger" role="status" title={problem}>
            {problem}
        </div>
    );
}

export function EmptyLine({ text, testId }: { text: string; testId: string }) {
    return (
        <div className="py-3 text-12 text-muted" data-testid={testId}>
            {text}
        </div>
    );
}
