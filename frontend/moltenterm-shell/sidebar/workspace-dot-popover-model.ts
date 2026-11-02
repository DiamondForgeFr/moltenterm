// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace dots' popover (FR-SHELL-082, #1645): which dot shows it and what it says. Kept apart from the
// components so the rules can be tested without the app.

import { pathBaseName } from "../workspace-project";
import { currentProject } from "./workspace-projects";

export const DotPopoverDelayMs = 150;

export type DotPopoverProject = { name: string; type: string };

// The workspace's current project: its folder's name and its type, null when the workspace has none.
export function dotPopoverProject(ws: { meta?: Record<string, any> }): DotPopoverProject {
    const project = currentProject(ws);
    if (project == null) {
        return null;
    }
    const name = pathBaseName(project.dir);
    if (name === "" && project.type === "") {
        return null;
    }
    return { name, type: project.type };
}

// The current workspace's dot says nothing new about where it leads: it shows the popover only with something to
// report. A dot being dragged never shows it.
export function dotShowsPopover(opts: { hovered: boolean; dragging: boolean; current: boolean; attention: number }) {
    if (!opts.hovered || opts.dragging) {
        return false;
    }
    return !opts.current || opts.attention > 0;
}

// The hover's timing: the first dot waits a short delay, the next ones along the row show at once until the pointer
// (or the focus) leaves the row.
export class DotPopoverHover {
    hoverId: string = null;
    warm = false;
    timer: ReturnType<typeof setTimeout> = null;
    onChange: (id: string) => void;
    delayMs: number;

    constructor(onChange: (id: string) => void, delayMs = DotPopoverDelayMs) {
        this.onChange = onChange;
        this.delayMs = delayMs;
    }

    enter(id: string) {
        this.clearTimer();
        if (this.warm) {
            this.show(id);
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.warm = true;
            this.show(id);
        }, this.delayMs);
    }

    // Off a dot but still on the row: the popover goes, the next dot shows at once.
    out() {
        this.clearTimer();
        this.show(null);
    }

    leave() {
        this.clearTimer();
        this.warm = false;
        this.show(null);
    }

    dispose() {
        this.clearTimer();
    }

    show(id: string) {
        if (this.hoverId === id) {
            return;
        }
        this.hoverId = id;
        this.onChange(id);
    }

    clearTimer() {
        if (this.timer == null) {
            return;
        }
        clearTimeout(this.timer);
        this.timer = null;
    }
}
