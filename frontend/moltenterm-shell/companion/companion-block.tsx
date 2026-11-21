// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The one block every section of the companion is drawn in (FR-SHELL-018, #2441, companion-dashboard.css): its label
// in a notch on the top border (a brass icon tile, the label chip or tabs, then count chips), its tools on their own
// chip in a notch on the right, its content, and its one link as its last row. Display only.

import { cn, makeIconClass } from "@/util/util";
import { forwardRef, useEffect, useId, useRef, useState } from "react";

export type CompanionBlockProps = {
    // The block's place in the flow (data-flow-id), which the flow measures and positions.
    flowId?: string;
    icon?: React.ReactNode;
    // The label chip's text; tabs replace it (the block is then named by its aria-label).
    label?: React.ReactNode;
    tabs?: React.ReactNode;
    // Off chips after the label: a count, "Hidden".
    chips?: React.ReactNode;
    // A handle before the tile, while arranging.
    grip?: React.ReactNode;
    tools?: React.ReactNode;
    foot?: React.ReactNode;
    tone?: "waiting";
    // The chip's heading level: the hero names the companion (h2), every other block a section (h3).
    heading?: "h2" | "h3";
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "children">;

export const CompanionBlock = forwardRef<HTMLElement, CompanionBlockProps>(function CompanionBlock(
    { flowId, icon, label, tabs, chips, grip, tools, foot, tone, heading = "h3", className, children, ...rest },
    ref
) {
    const headingId = useId();
    const Heading = heading;
    return (
        <section
            ref={ref}
            aria-labelledby={label != null && tabs == null && rest["aria-label"] == null ? headingId : undefined}
            {...rest}
            className={cn("mt-cb", className)}
            data-flow-id={flowId}
            data-tone={tone}
            data-foot={foot ? "" : undefined}
        >
            <div className="mt-cb-head">
                <span className="mt-cb-notch" data-side="label">
                    {grip}
                    {icon != null ? (
                        <span className="mt-cb-tile" aria-hidden="true">
                            {icon}
                        </span>
                    ) : null}
                    {tabs ??
                        (label != null ? (
                            <span className="mt-cb-chip">
                                <Heading id={headingId}>{label}</Heading>
                            </span>
                        ) : null)}
                    {chips}
                </span>
                {tools != null ? (
                    <span className="mt-cb-notch" data-side="tools">
                        <span className="mt-cb-tools">{tools}</span>
                    </span>
                ) : null}
            </div>
            <div className="mt-cb-body">{children}</div>
            {foot ? <div className="mt-cb-foot">{foot}</div> : null}
        </section>
    );
});

export function CountChip({ children, tip }: { children: React.ReactNode; tip?: string }) {
    return (
        <span className="mt-cb-chip mt-cb-chip-off" data-mono="" data-tip={tip}>
            {children}
        </span>
    );
}

// A ghost tool of the tools chip: an icon (or a short text) with its name for assistive technology and the popover.
export function BlockTool({
    label,
    onClick,
    disabled,
    pressed,
    children,
    className,
    testId,
    buttonRef,
    marker,
    tip,
}: {
    label: string;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    pressed?: boolean;
    children: React.ReactNode;
    className?: string;
    testId?: string;
    buttonRef?: React.Ref<HTMLButtonElement>;
    // A name the arranging mode finds the tool by, to give it the focus back after a move.
    marker?: string;
    // A popover that says more than the name.
    tip?: string;
}) {
    return (
        <button
            ref={buttonRef}
            type="button"
            className={cn("mt-cb-tool", className)}
            aria-label={label}
            data-tip={tip ?? label}
            disabled={disabled}
            aria-pressed={pressed}
            onClick={(e) => {
                e.stopPropagation();
                onClick(e);
            }}
            data-testid={testId}
            data-arrange={marker}
        >
            {children}
        </button>
    );
}

// A copy tool: the icon turns into a check for two seconds once it copied.
export function CopyTool({ label, onCopy }: { label: string; onCopy: () => void }) {
    const [copied, setCopied] = useState(false);
    const timer = useRef(0);
    useEffect(() => () => window.clearTimeout(timer.current), []);
    return (
        <BlockTool
            label={label}
            onClick={() => {
                if (copied) {
                    return;
                }
                setCopied(true);
                timer.current = window.setTimeout(() => setCopied(false), 2000);
                onCopy();
            }}
            testId="companion-copy"
        >
            <i
                className={makeIconClass(copied ? "check" : "copy", true)}
                data-copied={copied ? "" : undefined}
                aria-hidden="true"
            />
        </BlockTool>
    );
}

export function FootLink({
    children,
    onClick,
    testId,
}: {
    children: React.ReactNode;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    testId?: string;
}) {
    return (
        <button type="button" className="mt-cb-foot-link" onClick={onClick} data-testid={testId}>
            {children}
            <i className="fa fa-solid fa-arrow-up-right-from-square" aria-hidden="true" />
        </button>
    );
}

// "And N more" under a capped list, "Show less" once it is open.
export function MoreButton({
    more,
    open,
    onToggle,
    label,
    lessLabel,
    testId,
}: {
    more: number;
    open: boolean;
    onToggle: () => void;
    label: string;
    lessLabel: string;
    testId?: string;
}) {
    if (more <= 0 && !open) {
        return null;
    }
    return (
        <button
            type="button"
            className="mt-cb-more"
            aria-expanded={open}
            onClick={(e) => {
                e.stopPropagation();
                onToggle();
            }}
            data-testid={testId}
        >
            {open ? lessLabel : label}
        </button>
    );
}
