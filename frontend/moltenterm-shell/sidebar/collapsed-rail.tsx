// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The collapsed rail (FR-SHELL-079, #2384): with the sidebar hidden, what is left at the window's left edge is the current
// project's mark with the header's own liseré, in the workspace colour, so the developer still tells which project and
// workspace the window is on. Hovering the mark names both; a click opens what the header opens. The rail keeps the
// window's edge line the docked sidebar draws (the place strip): the window looks the same collapsed. The room it takes
// is the content's margin (sidebar.css), so no panel is covered and nothing waits for this code. Loaded on demand by
// workspace-sidebar.tsx: only a hidden sidebar shows it, so it stays out of the JS every tab view loads up front
// (NFR-PERF-003, bundle.initialJsMB).

import { atoms, globalStore } from "@/app/store/global";
import { getObjectValue, makeORef } from "@/app/store/wos";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { AgentStates } from "../agent-state-store";
import { useT } from "../i18n/i18n";
import { usePlatform } from "../keepawake-ui";
import { workspaceShownName } from "../workspace-default-name";
import { openWorkspaceEditor } from "../workspace-edit";
import { WorkspaceIcon } from "../workspace-icon";
import { workspaceIconSource } from "../workspace-icon-model";
import { markAction, markFace, markProjectName } from "./collapsed-mark-model";
import { useFoundLogos } from "./header-logo";
import { otherProjectsActivity } from "./project-activity";
import { headerIcon } from "./sidebar-header-model";
import { currentProject, readProjects } from "./workspace-projects";
import { projectMenuItems, showMenuUnder, workspaceMenuFor, type SidebarWorkspaces } from "./workspace-sidebar";

// `unfolded`: the sidebar is over the rail, which shows the header itself.
export function CollapsedRail({ workspaces, unfolded }: { workspaces: SidebarWorkspaces; unfolded: boolean }) {
    const t = useT();
    const platform = usePlatform();
    const ws = useAtomValue(atoms.workspace);
    const [menuOpen, setMenuOpen] = useState(false);
    const projects = readProjects(ws);
    const current = currentProject(ws);
    const foundLogos = useFoundLogos(projects.length > 1 ? (current?.dir ?? "") : "");
    const entry = workspaces.entries.find((e) => e.id === ws?.oid);
    const name = workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace");
    const project = markProjectName(ws);
    const title = project ? t("sidebar.collapsedMark", { name, project }) : name;
    const face = markFace(headerIcon(ws, foundLogos), name);
    const open = (anchor: HTMLElement) => {
        if (markAction(ws) === "project") {
            // The agents are read when the menu opens: the rail draws nothing of them.
            const activity = otherProjectsActivity(
                ws,
                projects,
                Object.values(globalStore.get(AgentStates.getInstance().dataAtom)?.states ?? {}),
                (blockId) => getObjectValue<Block>(makeORef("block", blockId))?.meta?.["cmd:cwd"] ?? ""
            );
            setMenuOpen(true);
            showMenuUnder(anchor, projectMenuItems(ws, t, activity), () => setMenuOpen(false));
            return;
        }
        if (entry == null || !entry.saved) {
            openWorkspaceEditor(ws?.oid, anchor);
            return;
        }
        setMenuOpen(true);
        showMenuUnder(anchor, workspaceMenuFor(entry, workspaces.entries, anchor, platform, t), () =>
            setMenuOpen(false)
        );
    };
    return (
        <div className="mt-sb-rail" data-testid="sidebar-collapsed-rail">
            <span className="mt-sb-place-strip" aria-hidden />
            <button
                type="button"
                className={cn("mt-sb-rail-mark", unfolded && "is-unfolded")}
                title={title}
                aria-label={title}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                tabIndex={unfolded ? -1 : 0}
                data-testid="sidebar-collapsed-mark"
                data-face={face.kind}
                onClick={(e) => open(e.currentTarget)}
            >
                <span className="mt-sb-place-bar" data-testid="sidebar-collapsed-place-bar" aria-hidden />
                {face.kind === "logo" ? (
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        <WorkspaceIcon
                            source={{ icon: "", color: "", image: "", logo: face.logo }}
                            className="h-4 w-4"
                        />
                    </span>
                ) : face.kind === "workspace" ? (
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        <WorkspaceIcon source={{ ...workspaceIconSource(ws), logo: "" }} className="h-4 w-4" />
                    </span>
                ) : (
                    <span className="mt-sb-rail-initial" aria-hidden>
                        {face.letter}
                    </span>
                )}
            </button>
        </div>
    );
}
