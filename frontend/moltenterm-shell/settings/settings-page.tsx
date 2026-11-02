// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The page language Settings, Secrets and Tips share (#534): a page filling its panel, a header with a title and one
// line, and blocks holding a group of rows, flowing into columns on a wide panel (#674). One place, so the three read
// as the same app. The blocks are the DiamondForge suite's (suite/suite.tsx, #658): the group's name in a chip on the
// top border, its icon on the corner. The side padding leaves room for the blocks' corner icons.

import { cn } from "@/util/util";
import { Children, isValidElement } from "react";
import { BlockRows, SectionBlock, SuiteIcon } from "../suite/suite";
import { BlockScopeTag, SettingsScopeKind } from "./settings-scope";

// How many columns a page may use on a wide panel (#674).
export type PageColumns = 1 | 2 | 3;

// The thresholds read the panel's width through the `page` container (`@container/page` on the scroller), not the
// window's: a panel can be narrow in a wide window. Two columns from 1100 px, three from 1680 px, so a column never
// gets under about 500 px and a row keeps its control beside its label.
const FlowColumnsClass: Record<PageColumns, string> = {
    1: "",
    2: "@min-[1100px]/page:columns-2",
    3: "@min-[1100px]/page:columns-2 @min-[1680px]/page:columns-3",
};

// About 760 px per column at most: past that a row's control drifts away from its label.
const FillMaxWidthClass: Record<PageColumns, string> = {
    1: "max-w-[960px]",
    2: "max-w-[1616px]",
    3: "max-w-[2408px]",
};

// Items flowing into columns down then across, each kept whole: CSS columns keep the reading order and let a short
// block rise under another, where a grid would leave a hole beside the tallest block of each row.
export function flowColumnsClass(columns: PageColumns): string {
    return cn("gap-x-8 [&>*]:break-inside-avoid", FlowColumnsClass[columns]);
}

// The page filling its panel (#674): left-aligned beside the section list, as wide as `width` columns allow.
export function PageFill({
    width,
    children,
    className,
}: {
    width: PageColumns;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "flex w-full flex-col px-8 pt-6 pb-12 @max-w600/page:px-5",
                FillMaxWidthClass[width],
                className
            )}
        >
            {children}
        </div>
    );
}

// A page's blocks, in columns when the panel is wide. Each block sits in a cell whose top padding is the block gap: a
// margin would vanish at the top of the second and third columns, and the chip and icon tile rising above a block's
// border would be clipped there. The flow keeps its own width cap, so one block above a wider one (Keyboard's keys
// above the shortcuts) does not stretch its rows across the page.
export function PageFlow({
    columns,
    children,
    className,
}: {
    columns: PageColumns;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div className={cn(flowColumnsClass(columns), FillMaxWidthClass[columns], className)}>
            {Children.toArray(children).map((child, i) => (
                <div
                    key={isValidElement(child) && child.key != null ? child.key : i}
                    className="pt-(--df-block-gap) [&>.df-block]:mt-0"
                >
                    {child}
                </div>
            ))}
        </div>
    );
}

// A page's number of columns: one per block, three at most.
export function pageColumns(blocks: number): PageColumns {
    return Math.min(3, Math.max(1, blocks)) as PageColumns;
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
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-4 bg-surface-2 text-secondary">
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
    scope,
}: {
    title?: string;
    hint?: React.ReactNode;
    // Who the block's settings apply to, the first line of a settings block (FR-SHELL-101).
    scope?: SettingsScopeKind;
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
            {scope != null ? <BlockScopeTag scope={scope} /> : null}
        </SectionBlock>
    );
}

// A row of a card: label and description on the left, the control on the right; flush with the block's edges.
export const PageRowClass = "flex items-center gap-4 px-5 py-3";
