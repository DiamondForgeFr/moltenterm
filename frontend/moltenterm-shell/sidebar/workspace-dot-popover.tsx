// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The popover above a workspace dot (FR-SHELL-082, #1645): the workspace with its colour mark, its project, what needs
// attention and its jump key. It never takes the focus or a click: the dot keeps both, and its aria-label says the
// same.

import { autoUpdate, FloatingPortal, offset, shift, useFloating } from "@floating-ui/react";
import { useT } from "../i18n/i18n";
import { DotPopoverProject } from "./workspace-dot-popover-model";

export type WorkspaceDotCardProps = {
    name: string;
    // The workspace's colour stops; none paints the mark in the secondary text colour.
    stops: string[];
    project: DotPopoverProject;
    attention: string[];
    // The formatted jump key, "" when the dot has none.
    keys: string;
};

function placeVars(stops: string[]): React.CSSProperties {
    if (stops.length === 0) {
        return { ["--mt-place" as string]: "var(--color-secondary)" } as React.CSSProperties;
    }
    return {
        ["--mt-place" as string]: stops[0],
        ["--mt-place-mid" as string]: stops[Math.floor(stops.length / 2)],
        ["--mt-place-end" as string]: stops[stops.length - 1],
    } as React.CSSProperties;
}

export function WorkspaceDotCard({ name, stops, project, attention, keys }: WorkspaceDotCardProps) {
    const t = useT();
    let projectText = "";
    if (project != null) {
        projectText =
            project.name && project.type
                ? t("sidebar.dots.project", { name: project.name, type: project.type })
                : project.name || project.type;
    }
    return (
        <div className="flex min-w-0 flex-col gap-0.5" style={placeVars(stops)}>
            <div className="flex min-w-0 items-center gap-2">
                <span className="mt-sb-place-bar" data-testid="sidebar-dot-popover-mark" aria-hidden />
                <span className="truncate text-12 font-semibold text-primary" data-testid="sidebar-dot-popover-name">
                    {name}
                </span>
                {keys ? (
                    <kbd className="mt-sb-dot-pop-keys ml-auto shrink-0" data-testid="sidebar-dot-popover-keys">
                        {keys}
                    </kbd>
                ) : null}
            </div>
            {projectText ? (
                <div className="truncate pl-[11px] text-11 text-secondary" data-testid="sidebar-dot-popover-project">
                    {projectText}
                </div>
            ) : null}
            {attention.map((line, i) => (
                <div
                    key={i}
                    className="truncate pl-[11px] text-11 text-primary"
                    data-testid="sidebar-dot-popover-attention"
                >
                    {line}
                </div>
            ))}
        </div>
    );
}

export function WorkspaceDotPopover({ anchor, ...card }: WorkspaceDotCardProps & { anchor: HTMLElement }) {
    const { refs, floatingStyles } = useFloating({
        open: true,
        placement: "top",
        elements: { reference: anchor },
        middleware: [offset(8), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    return (
        <FloatingPortal>
            <div
                ref={refs.setFloating}
                style={floatingStyles}
                className="pointer-events-none z-[1000]"
                aria-hidden
                data-testid="sidebar-dot-popover"
            >
                <div className="mt-sb-pop mt-sb-dot-pop rounded-4 px-2.5 py-1.5">
                    <WorkspaceDotCard {...card} />
                </div>
            </div>
        </FloatingPortal>
    );
}
