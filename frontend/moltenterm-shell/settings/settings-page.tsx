// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The page language Settings, Secrets and Tips share (#534): a centred column, a header with a title and one line,
// and blocks holding a group of rows. One place, so the three read as the same app. The blocks are the DiamondForge
// suite's (suite/suite.tsx, #658): the group's name in a chip on the top border, its icon on the corner.

import { cn } from "@/util/util";
import { BlockRows, SectionBlock, SuiteIcon } from "../suite/suite";

// The centred column; a wide pane leaves room on both sides instead of pushing everything to the left. The side
// padding leaves room for the blocks' corner icons.
export function PageColumn({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("mx-auto flex w-full max-w-[760px] flex-col px-8 pt-6 pb-12 @max-w600:px-5", className)}>
            {children}
        </div>
    );
}

export function PageHeader({
    title,
    description,
    icon,
    children,
}: {
    title: string;
    description?: React.ReactNode;
    // A Font Awesome name, or a suite icon.
    icon?: string | SuiteIcon;
    children?: React.ReactNode;
}) {
    const Icon = typeof icon === "string" ? null : icon;
    return (
        <header className="flex items-start gap-3 pb-2">
            {icon ? (
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-4 bg-surface-2 text-accent">
                    {Icon ? (
                        <Icon className="h-4 w-4" aria-hidden />
                    ) : (
                        <i className={`fa fa-solid fa-${icon} text-icon-16`} aria-hidden />
                    )}
                </span>
            ) : null}
            <div className="min-w-0 flex-1">
                <h2 className="text-20 leading-8 font-semibold text-primary">{title}</h2>
                {description ? <p className="text-13 leading-5 text-secondary">{description}</p> : null}
            </div>
            {children ? <div className="flex shrink-0 items-center gap-2 pt-1">{children}</div> : null}
        </header>
    );
}

// A group of rows: a suite block, its name in the chip, the hint as its description line, the rows flush inside.
export function PageCard({
    title,
    hint,
    icon,
    glow,
    titleCase,
    footer,
    children,
    className,
    label,
}: {
    title?: string;
    hint?: React.ReactNode;
    icon?: SuiteIcon;
    // The turning light, while the block holds the row a search jumped to.
    glow?: boolean;
    titleCase?: "upper" | "as-is";
    // An action straddling the bottom border (Secrets' "Add a secret").
    footer?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
    label?: string;
}) {
    return (
        <SectionBlock
            title={title}
            aria-label={title ? undefined : label}
            icon={icon}
            description={hint}
            glow={glow}
            titleCase={titleCase}
            footer={footer}
            className={className}
        >
            <BlockRows>{children}</BlockRows>
        </SectionBlock>
    );
}

// A row of a card: label and description on the left, the control on the right; flush with the block's edges.
export const PageRowClass = "flex items-center gap-4 px-5 py-3";
