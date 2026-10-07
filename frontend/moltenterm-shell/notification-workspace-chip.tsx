// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { WorkspaceLabel, workspaceLabelText } from "./notification-workspace";
import { WorkspaceIcon } from "./workspace-icon";

// The workspace an item belongs to, at the start of its meta line (#282). The badge is the rail's resolved icon in the
// workspace's colour, on a faint tint drawn with an inline style: the panel's text colours stay on the name, so no
// accent foreground lands on a tint (#244). In a narrow popover the name truncates and the badge never does.
export function WorkspaceChip({ label, onGo }: { label: WorkspaceLabel; onGo: () => void }) {
    const text = workspaceLabelText(label);
    const content = (
        <>
            <span
                aria-hidden
                data-testid="workspace-badge"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-[10px]"
                style={{
                    background: label.color
                        ? `color-mix(in srgb, ${label.color} 18%, transparent)`
                        : "var(--color-hover)",
                }}
            >
                {label.missing ? (
                    <i className="fa fa-solid fa-ghost text-muted" />
                ) : (
                    <WorkspaceIcon
                        source={{ icon: label.icon, color: label.color, image: label.image, logo: label.logo }}
                        className="text-[10px]"
                    />
                )}
            </span>
            <span className="min-w-0 truncate" data-testid="workspace-name">
                {label.name}
                {label.project ? <span className="text-muted"> · {label.project}</span> : null}
            </span>
        </>
    );
    if (label.missing) {
        return (
            <span
                className="flex min-w-0 max-w-[60%] items-center gap-1 text-secondary"
                data-testid="workspace-chip"
                title={text}
            >
                {content}
            </span>
        );
    }
    return (
        <button
            type="button"
            title={label.current ? text : `Go to ${text}`}
            aria-label={label.current ? `Workspace ${text}` : `Go to workspace ${text}`}
            data-testid="workspace-chip"
            data-current={label.current ? "true" : undefined}
            onClick={(e) => {
                e.stopPropagation();
                onGo();
            }}
            className={cn(
                "-mx-1 flex min-w-0 max-w-[60%] cursor-pointer items-center gap-1 rounded px-1 text-secondary",
                "hover:bg-hover hover:text-primary"
            )}
        >
            {content}
        </button>
    );
}
