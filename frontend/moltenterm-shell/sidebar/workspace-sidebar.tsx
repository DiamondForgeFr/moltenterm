// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace sidebar (FR-SHELL-079, DS-SHELL-123, DS-SHELL-124): each workspace's own column on the left, in place
// of the tab bar, the workspace rail and the status bar. Top to bottom: the window row (sidebar toggle; keep-awake and
// notifications), the workspace header (name, project type, its menu on hover), the tiles (pinned tabs), the temporary
// views (the other tabs, New view), the branch and build line, and the bottom bar (library, workspace dots, +).
// Everything the replaced bars offered keeps a home here or in these menus (see the PR of #1183 for the mapping).

import { getTabBadgeAtom } from "@/app/store/badge";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms, getApi, getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { getTabModelByTabId } from "@/app/store/tab-model";
import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TabEnv } from "@/app/tab/tab";
import { TabBadges } from "@/app/tab/tabbadges";
import { buildTabContextMenu } from "@/app/tab/tabcontextmenu";
import { UpdateStatusBanner } from "@/app/tab/updatebanner";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { AppsFloatingWindow, type WidgetsEnv } from "@/app/workspace/widgets";
import { deleteLayoutModelForTab, getLayoutModelForStaticTab } from "@/layout/index";
import { validateCssColor } from "@/util/color-validator";
import { isMacOS, isMacOSTahoeOrLater } from "@/util/platformutil";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentStateTitle } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { currentEqualize } from "../equalize/equalize-actions";
import { HoldToCloseButton } from "../hold-to-close";
import { useT, useTCount } from "../i18n/i18n";
import { coffeeCondition, coffeeSupported } from "../keepawake-model";
import { KeepAwakeModel } from "../keepawake-store";
import { KeepAwakeStatusItem, usePlatform } from "../keepawake-ui";
import { MoltentermCicdView } from "../mission/cicd-view";
import { NotificationCenter } from "../notification-center";
import { unreadByWorkspace } from "../notifications-model";
import { MoltentermNotifications } from "../notifications-store";
import { openMoltentermView, toggleMoltentermView } from "../open-view";
import { openWebLink } from "../open-web-link";
import { openProjectOverview, openProjectTab } from "../project/project-tab";
import { productKeysOf } from "../rail-groups";
import { useRailGroups, useStoredLocalGroups, useWorkspaceLinksKey } from "../rail-groups-store";
import {
    effectiveLocalGroups,
    groupWithChoices,
    joinRailGroup,
    leaveRailGroup,
    localGroupOf,
    LocalRailGroup,
} from "../rail-local-groups";
import { railCustomWidgets, railWidgetTooltip } from "../rail-tools-model";
import { railWorkspaceMenu } from "../rail-tray-model";
import { ReleaseNotesHost } from "../releases/release-notes-host";
import { ReleaseNotesModel } from "../releases/release-notes-store";
import { useListedReviewsAnswer, useReviewsRailWatch } from "../reviews/reviews-client";
import { MoltentermReviewsView, reviewCounts, reviewsRailLabel } from "../reviews/reviews-model";
import { ReviewsModel } from "../reviews/reviews-store";
import { MoltentermSessionsView } from "../sessions/sessions-model";
import { DurableSessions } from "../sessions/sessions-store";
import { acceleratorById, formatShortcutById } from "../shortcuts/format";
import { finishTabPanelDrag, trackTabPanelDrag } from "../split/drop-zones";
import { ChannelClasses, ItemButton, useFocusedPane, useStatusBarView } from "../status-bar";
import { DominoLoader } from "../suite/suite";
import "../tab-bar.css";
import { TabAgentMark, TabAgentName, TabReviewMark, useTabIdentity, useTabTooltip } from "../tab-identity-ui";
import { MoltentermTipsView } from "../tips/tips-view";
import { ReleaseUpdateButton } from "../update/release-update-ui";
import { GoldUpdateButton } from "../update/update-dialog";
import { View360ExitHost, view360MenuItems } from "../view360/view360-toggle";
import { colourChoiceCss, colourChoiceForeground, colourStops } from "../workspace-colour";
import { workspaceShownName } from "../workspace-default-name";
import { openWorkspaceEditor } from "../workspace-edit";
import { moveWorkspace, neighbourMove, RailMove, slotMove } from "../workspace-order";
import { readWorkspaceProject } from "../workspace-project";
import { loadWorkspaceSources, WorkspaceRailHosts } from "../workspace-rail";
import { makeWorkspaceRailEntries, WorkspaceRailEntry, WorkspaceRailSource } from "../workspace-rail-model";
import { askResetWorkspace } from "../workspace-reset";
import { canCloseWorkspace, lastWorkspaceReason } from "../workspace-reset-model";
import { closeTabAskingFirst } from "../worktree-close";
import { useTabTreesTooltip, WorktreeChip } from "../worktree-ui";
import { SidebarGlyph } from "./sidebar-icons";
import {
    buildLetterKey,
    dotDropSlot,
    dotMoveKey,
    dropTargetAt,
    groupWithJoin,
    moveTabBefore,
    readProjectType,
    SidebarDefaultWidth,
    SidebarMaxWidth,
    SidebarMinWidth,
    TileGridColumns,
} from "./sidebar-model";
import { SidebarModel } from "./sidebar-store";
import "./sidebar.css";

type SidebarEnv = TabEnv & WidgetsEnv;

const MacTrafficLightsWidth = 74;
const MacTahoeTrafficLightsWidth = 80;
const WindowRowHeight = "max(33px, calc(33px * var(--zoomfactor-inv)))";
const DragThresholdPx = 4;

const IconButton =
    "relative flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-6 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary";
const NoDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
const Drag = { WebkitAppRegion: "drag" } as React.CSSProperties;

// A native menu placed under its button, as a click from the keyboard would have none.
function showMenuUnder(anchor: HTMLElement, items: ContextMenuItem[], onClose?: () => void) {
    const rect = anchor.getBoundingClientRect();
    const event = {
        clientX: rect.left,
        clientY: rect.bottom + 4,
        target: anchor,
        stopPropagation: () => {},
        preventDefault: () => {},
    } as unknown as React.MouseEvent;
    ContextMenuModel.getInstance().showContextMenu(items, event, { onClose });
}

function useWorkspaceEntries(): WorkspaceRailEntry[] {
    const active = useAtomValue(atoms.workspace);
    const [sources, setSources] = useState<WorkspaceRailSource[]>([]);
    const refresh = useCallback(() => {
        fireAndForget(async () => setSources(await loadWorkspaceSources()));
    }, []);
    useEffect(() => {
        refresh();
        return waveEventSubscribeSingle({ eventType: "workspace:update", handler: refresh });
    }, [refresh]);
    useEffect(refresh, [active?.oid, active?.name, active?.icon, active?.color, refresh]);
    return makeWorkspaceRailEntries(sources, active);
}

// The workspaces the dots show, and what grouping needs: the saved ones in rail order, the project products and the
// local groups (FR-MC-027, FR-MC-032), read as the rail reads them.
type SidebarWorkspaces = {
    entries: WorkspaceRailEntry[];
    savedIds: string[];
    productKeys: Map<string, string>;
    localGroups: LocalRailGroup[];
};

function useSidebarWorkspaces(): SidebarWorkspaces {
    const entries = useWorkspaceEntries();
    const savedKey = entries
        .filter((e) => e.saved)
        .map((e) => e.id)
        .join(" ");
    const savedIds = useMemo(() => (savedKey ? savedKey.split(" ") : []), [savedKey]);
    const groups = useRailGroups(useWorkspaceLinksKey(savedIds));
    const productKeys = useMemo(() => productKeysOf(groups), [groups]);
    const stored = useStoredLocalGroups();
    const localGroups = useMemo(
        () => effectiveLocalGroups(stored, savedIds, productKeys),
        [stored, savedIds, productKeys]
    );
    return { entries, savedIds, productKeys, localGroups };
}

function runGroupCall(call: () => Promise<void>) {
    fireAndForget(async () => {
        try {
            await call();
        } catch (err) {
            console.log("sidebar workspace groups:", err);
        }
    });
}

// "Group with…" and "Remove from group", as the rail offered them (FR-MC-032); a workspace of a project product is
// grouped by its project. #1191's multi-project workspaces replace them.
function groupMenuItems(
    entry: WorkspaceRailEntry,
    workspaces: SidebarWorkspaces,
    t: (key: string, vars?: Record<string, any>) => string
): ContextMenuItem[] {
    if (!entry.saved || workspaces.productKeys.has(entry.id)) {
        return [];
    }
    const names = new Map(workspaces.entries.map((e) => [e.id, e.name]));
    const own = localGroupOf(workspaces.localGroups, entry.id);
    const choices = groupWithChoices(
        entry.id,
        workspaces.savedIds,
        workspaces.productKeys,
        workspaces.localGroups,
        (id) => names.get(id)
    );
    const section = t("rail.menu.groupSection");
    const items: ContextMenuItem[] = [];
    if (choices.length > 0) {
        items.push({
            label: t("rail.menu.groupWith"),
            icon: "link",
            section,
            type: "submenu",
            submenu: choices.map((choice) => ({
                label: choice.label,
                click: () => runGroupCall(() => joinRailGroup(groupWithJoin(entry.id, choice, own?.id))),
            })),
        });
    }
    if (own != null) {
        items.push({
            label: t("rail.menu.removeFromGroup"),
            icon: "link-slash",
            section,
            click: () => runGroupCall(() => leaveRailGroup({ workspaceid: entry.id })),
        });
    }
    return items;
}

// The menu of a workspace (the rail's, FR-SHELL-045): edit, Project tab, keep awake while working, grouping, reset,
// delete.
function workspaceMenuItems(
    entry: WorkspaceRailEntry,
    workspaces: SidebarWorkspaces,
    anchor: HTMLElement,
    platform: string,
    t: (key: string, vars?: Record<string, any>) => string
): ContextMenuItem[] {
    const items = baseWorkspaceMenuItems(entry, workspaces.entries, anchor, platform, t);
    const grouping = groupMenuItems(entry, workspaces, t);
    const at = items.findIndex((item) => item.type === "separator");
    if (grouping.length === 0 || at < 0) {
        return items;
    }
    return [...items.slice(0, at), ...grouping, ...items.slice(at)];
}

function baseWorkspaceMenuItems(
    entry: WorkspaceRailEntry,
    entries: WorkspaceRailEntry[],
    anchor: HTMLElement,
    platform: string,
    t: (key: string, vars?: Record<string, any>) => string
): ContextMenuItem[] {
    const keepAwake = KeepAwakeModel.getInstance();
    const coffee = globalStore.get(keepAwake.coffeeAtom(entry.id));
    const ws = globalStore.get(atoms.workspace);
    const projectDir = entry.active ? readWorkspaceProject(ws).dir : "";
    return railWorkspaceMenu({
        onEdit: () => openWorkspaceEditor(entry.id, anchor),
        coffee: coffeeSupported(platform)
            ? {
                  label: t("rail.keepAwakeWhileWorking"),
                  on: coffee != null,
                  onToggle: () =>
                      fireAndForget(async () => {
                          try {
                              await keepAwake.setCoffee(entry.id, coffee == null);
                          } catch (err) {
                              console.log("keep-awake coffee:", err);
                          }
                      }),
              }
            : undefined,
        onProjectTab: projectDir ? () => fireAndForget(openProjectTab) : undefined,
        onReset: () => askResetWorkspace(entry.id),
        remove: {
            enabled: canCloseWorkspace(entries, entry.id),
            reason: lastWorkspaceReason(),
            onDelete: () => getApi().deleteWorkspace(entry.id),
        },
    });
}

function trafficLightsRoom(isFullScreen: boolean, zoomFactor: number): number {
    if (!isMacOS() || isFullScreen) {
        return 0;
    }
    const width = isMacOSTahoeOrLater() ? MacTahoeTrafficLightsWidth : MacTrafficLightsWidth;
    return zoomFactor > 0 ? width / zoomFactor : width;
}

function AppMenuButton() {
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const showMenuBar = useAtomValue(getSettingsKeyAtom("window:showmenubar"));
    if (isMacOS() || showMenuBar) {
        return null;
    }
    return (
        <button
            type="button"
            className={IconButton}
            style={NoDrag}
            aria-label={t("sidebar.appMenu")}
            title={t("sidebar.appMenu")}
            onClick={() => getApi().showWorkspaceAppMenu(ws?.oid)}
        >
            <i className="fa fa-solid fa-ellipsis text-icon-14" aria-hidden />
        </button>
    );
}

function ToggleButton() {
    const t = useT();
    const hidden = useAtomValue(SidebarModel.getInstance().hiddenAtom);
    const keys = formatShortcutById("toggle-sidebar");
    const label = t(hidden ? "sidebar.show" : "sidebar.hide", { keys });
    return (
        <button
            type="button"
            className={IconButton}
            style={NoDrag}
            aria-label={label}
            title={label}
            data-testid="sidebar-toggle"
            onClick={() => SidebarModel.getInstance().toggleHidden()}
        >
            <SidebarGlyph name="sidebar" />
        </button>
    );
}

// The window's own row: the room the window buttons take, then the toggle; keep-awake and notifications on the right.
function WindowRow({ leftInset }: { leftInset: number }) {
    const isFullScreen = useAtomValue(atoms.isFullScreen);
    const zoomFactor = useAtomValue(atoms.zoomFactorAtom);
    const room = Math.max(0, trafficLightsRoom(isFullScreen, zoomFactor) - leftInset);
    return (
        <div className="flex shrink-0 items-center gap-1.5" style={{ height: WindowRowHeight, ...Drag }}>
            {room > 0 ? <div className="shrink-0" style={{ width: room }} /> : null}
            <AppMenuButton />
            <ToggleButton />
            <div className="h-full flex-1" />
            <KeepAwakeStatusItem variant="sidebar" />
            <NotificationCenter />
        </div>
    );
}

// Above the content where the window needs room of its own: the window buttons when the sidebar is hidden (with the
// toggle beside them), and the window controls on the right off macOS.
export function SidebarContentStrip() {
    const isFullScreen = useAtomValue(atoms.isFullScreen);
    const zoomFactor = useAtomValue(atoms.zoomFactorAtom);
    const hidden = useAtomValue(SidebarModel.getInstance().hiddenAtom);
    if (!hidden && isMacOS()) {
        // The content sits in the window with the sidebar's 8 px margin, which still moves the window.
        return <div className="h-2 shrink-0" style={Drag} />;
    }
    const room = hidden ? trafficLightsRoom(isFullScreen, zoomFactor) : 0;
    return (
        <div
            className="flex shrink-0 items-center gap-1.5 pl-1.5"
            style={{ height: WindowRowHeight, ...Drag }}
            data-testid="sidebar-content-strip"
        >
            {room > 0 ? <div className="shrink-0" style={{ width: room }} /> : null}
            {hidden ? <AppMenuButton /> : null}
            {hidden ? <ToggleButton /> : null}
        </div>
    );
}

function WorkspaceHeader({ workspaces }: { workspaces: SidebarWorkspaces }) {
    const t = useT();
    const platform = usePlatform();
    const ws = useAtomValue(atoms.workspace);
    const [menuOpen, setMenuOpen] = useState(false);
    const moreRef = useRef<HTMLButtonElement>(null);
    const entry = workspaces.entries.find((e) => e.id === ws?.oid);
    const name = workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace");
    const type = readProjectType(ws);
    const openMenu = (anchor: HTMLElement) => {
        if (entry == null || !entry.saved) {
            openWorkspaceEditor(ws?.oid, anchor);
            return;
        }
        setMenuOpen(true);
        showMenuUnder(anchor, workspaceMenuItems(entry, workspaces, anchor, platform, t), () => setMenuOpen(false));
    };
    return (
        <div
            className="mt-sb-hdr flex shrink-0 items-center gap-1.5 border-t border-white/10 px-0.5 pt-1.5"
            data-testid="sidebar-header"
            onContextMenu={(e) => {
                e.preventDefault();
                openMenu(moreRef.current ?? (e.currentTarget as HTMLElement));
            }}
        >
            <span
                className="max-w-[60%] shrink-0 truncate text-11 font-semibold tracking-[0.08em] uppercase"
                style={{ color: "color-mix(in srgb, var(--color-primary) 82%, var(--mt-accent))" }}
                title={name}
                data-testid="sidebar-workspace-name"
            >
                {name}
            </span>
            {type ? (
                <button
                    type="button"
                    className="mt-sb-type inline-flex h-[22px] min-w-0 shrink cursor-pointer items-center gap-[3px] overflow-hidden rounded-6 px-1.5 text-12 whitespace-nowrap text-muted transition-colors duration-120 ease-mt"
                    title={t("sidebar.header.typeTitle", { type })}
                    data-testid="sidebar-project-type"
                    onClick={(e) => openMenu(e.currentTarget)}
                >
                    <span className="truncate">{type}</span>
                    <SidebarGlyph name="chev" size={11} />
                </button>
            ) : null}
            <button
                ref={moreRef}
                type="button"
                className="mt-sb-hover-ctl ml-auto flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
                aria-label={t("sidebar.header.menu", { name })}
                title={t("sidebar.header.menu", { name })}
                aria-expanded={menuOpen}
                data-testid="sidebar-workspace-menu"
                onClick={(e) => openMenu(e.currentTarget)}
            >
                <SidebarGlyph name="more" />
            </button>
        </div>
    );
}

// The tab's menu (rename, flag, backgrounds, copy id, reopen, close) without the tab bar position, which the sidebar
// replaces; the view on screen adds equalize and 360 view, whose buttons sat in the tab bar.
function viewMenuItems(
    tabId: string,
    active: boolean,
    renameRef: React.RefObject<() => void>,
    onClose: () => void,
    env: SidebarEnv,
    t: (key: string, vars?: Record<string, any>) => string
): ContextMenuItem[] {
    const tabBarPosition = t("wave.tab.tabBarPosition");
    const items = buildTabContextMenu(tabId, renameRef, () => onClose(), env).filter(
        (item) => item.label !== tabBarPosition
    );
    if (!active) {
        return items;
    }
    const layout: ContextMenuItem[] = [];
    const equalize = currentEqualize();
    if (equalize != null) {
        const auto = equalize.auto;
        layout.push(
            {
                label: t("sidebar.view.equalize"),
                icon: "table-columns",
                enabled: globalStore.get(equalize.canEqualizeAtom) && !auto,
                accelerator: acceleratorById("equalize-panels"),
                click: () => equalize.equalize(),
            },
            {
                label: t("sidebar.view.equalizeAuto"),
                type: "checkbox",
                checked: auto,
                click: () => equalize.setAuto(!auto),
            }
        );
    }
    const view360 = getLayoutModelForStaticTab()?.moltenView360;
    if (view360 != null) {
        layout.push({ label: t("sidebar.view.view360"), type: "submenu", submenu: view360MenuItems(view360) });
    }
    if (layout.length === 0) {
        return items;
    }
    return [items[0], ...layout, { type: "separator" }, ...items.slice(1)];
}

function useFlagColor(tab: Tab): string {
    const raw = tab?.meta?.["tab:flagcolor"];
    if (!raw) {
        return null;
    }
    try {
        validateCssColor(raw);
        return raw;
    } catch {
        return null;
    }
}

function useViewActions(tabId: string, active: boolean) {
    const env = useWaveEnv<SidebarEnv>();
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const confirmClose = useAtomValue(env.getSettingsKeyAtom("tab:confirmclose")) ?? false;
    const renameRef = useRef<() => void>(null);
    const close = useCallback(() => {
        closeTabAskingFirst(getApi().closeTab, ws?.oid, tabId, confirmClose)
            .then((closed) => {
                if (closed) {
                    deleteLayoutModelForTab(tabId);
                }
            })
            .catch((e) => console.log("closing a view from the sidebar", e));
    }, [ws?.oid, tabId, confirmClose]);
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        env.showContextMenu(viewMenuItems(tabId, active, renameRef, close, env, t), e);
    };
    return { env, renameRef, close, onContextMenu };
}

function Tile({ tabId, active }: { tabId: string; active: boolean }) {
    const [tab] = useWaveObjectValue<Tab>(makeORef("tab", tabId));
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    const { onContextMenu } = useViewActions(tabId, active);
    return (
        <button
            type="button"
            className={cn(
                "relative flex h-[52px] min-w-0 cursor-pointer flex-col items-center justify-center gap-[5px] rounded-6 px-1 text-11 text-primary transition-colors duration-120 ease-mt",
                active
                    ? "bg-white/20 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]"
                    : "bg-white/[0.09] hover:bg-white/15"
            )}
            aria-current={active ? "page" : undefined}
            title={identity.name}
            data-testid="sidebar-tile"
            data-tab-id={tabId}
            onClick={() => getApi().setActiveTab(tabId)}
            onContextMenu={onContextMenu}
        >
            <i
                className={cn(makeIconClass(identity.icon, true, { defaultIcon: "square" }), "text-icon-16")}
                aria-hidden
            />
            <span className="max-w-full truncate">{identity.name}</span>
            <span className="absolute top-1.5 right-1.5 flex">
                <TabAgentMark info={identity.agent} />
            </span>
        </button>
    );
}

function TileGrid({ tileIds, activeTabId, label }: { tileIds: string[]; activeTabId: string; label: string }) {
    if (tileIds.length === 0) {
        return null;
    }
    return (
        <div
            className="grid shrink-0 gap-1.5 px-1 pt-[7px] pb-0.5"
            style={{ gridTemplateColumns: TileGridColumns }}
            aria-label={label}
            data-testid="sidebar-tiles"
        >
            {tileIds.map((id) => (
                <Tile key={id} tabId={id} active={id === activeTabId} />
            ))}
        </div>
    );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
    const ref = useRef<HTMLInputElement>(null);
    const doneRef = useRef(false);
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);
    const finish = (name: string) => {
        if (doneRef.current) {
            return;
        }
        doneRef.current = true;
        onDone(name);
    };
    return (
        <input
            ref={ref}
            defaultValue={initial}
            className="min-w-0 flex-1 rounded-4 border border-line-strong bg-black/30 px-1 text-12 text-primary outline-none"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                    finish(ref.current.value.trim() || initial);
                } else if (e.key === "Escape") {
                    finish(initial);
                }
            }}
            onBlur={() => finish(ref.current?.value.trim() || initial)}
        />
    );
}

type RowDrag = { onMouseDown: (e: React.MouseEvent, tabId: string) => void; takeClick: () => boolean };

function ViewRow({
    tabId,
    active,
    dragging,
    dropBefore,
    drag,
}: {
    tabId: string;
    active: boolean;
    dragging: boolean;
    dropBefore: boolean;
    drag: RowDrag;
}) {
    const [tab] = useWaveObjectValue<Tab>(makeORef("tab", tabId));
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    const { env, renameRef, close, onContextMenu } = useViewActions(tabId, active);
    const badges = useAtomValue(getTabBadgeAtom(tabId, env));
    const trees = useTabTreesTooltip(tabId);
    const [hoverNow, setHoverNow] = useState(() => Date.now());
    const title = useTabTooltip(identity, trees.title, hoverNow);
    const flagColor = useFlagColor(tab);
    const [renaming, setRenaming] = useState(false);
    renameRef.current = () => setRenaming(true);
    const tabModel = getTabModelByTabId(tabId, env);
    useEffect(() => {
        const cb = () => setRenaming(true);
        tabModel.startRenameCallback = cb;
        return () => {
            if (tabModel.startRenameCallback === cb) {
                tabModel.startRenameCallback = null;
            }
        };
    }, [tabModel]);
    const rename = (name: string) => {
        setRenaming(false);
        if (name !== identity.name) {
            fireAndForget(() => env.rpc.UpdateTabNameCommand(TabRpcClient, tabId, name));
        }
    };
    const activate = () => {
        if (drag.takeClick() || renaming) {
            return;
        }
        getApi().setActiveTab(tabId);
    };
    return (
        <div
            role="button"
            tabIndex={0}
            className={cn(
                "mt-sb-row relative flex min-h-[30px] w-full shrink-0 cursor-pointer items-center gap-2 rounded-6 px-2 text-left text-12 transition-colors duration-120 ease-mt",
                active ? "bg-white/15 text-primary" : "text-secondary hover:bg-white/[0.08] hover:text-primary",
                dragging && "opacity-60"
            )}
            aria-current={active ? "page" : undefined}
            title={renaming ? undefined : title || undefined}
            data-testid="sidebar-view-row"
            data-tab-id={tabId}
            onClick={activate}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    getApi().setActiveTab(tabId);
                }
            }}
            onMouseDown={(e) => {
                if (!renaming) {
                    drag.onMouseDown(e, tabId);
                }
            }}
            onAuxClick={(e) => {
                if (e.button !== 1 || renaming) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                close();
            }}
            onContextMenu={onContextMenu}
            onMouseEnter={() => {
                trees.onMouseEnter?.();
                setHoverNow(Date.now());
            }}
        >
            {dropBefore ? (
                <span className="pointer-events-none absolute -top-px right-1 left-1 h-[2px] rounded-full bg-accent" />
            ) : null}
            <i
                className={cn(
                    makeIconClass(identity.icon, true, { defaultIcon: "square" }),
                    "w-4 shrink-0 text-center text-icon-14"
                )}
                aria-hidden
            />
            {renaming ? (
                <RenameInput initial={identity.name} onDone={rename} />
            ) : (
                <span
                    className="min-w-0 shrink truncate"
                    onDoubleClick={(e) => {
                        e.stopPropagation();
                        setRenaming(true);
                    }}
                >
                    {identity.name}
                </span>
            )}
            {renaming ? null : <TabAgentName agents={identity.agents} />}
            <span className="flex-1" />
            <TabReviewMark done={identity.reviewDone} />
            <TabAgentMark info={identity.agent} />
            <TabBadges badges={badges} flagColor={flagColor} className="static w-auto translate-y-0" />
            <span className="mt-sb-hover-ctl flex shrink-0 items-center" onMouseDown={(e) => e.stopPropagation()}>
                <HoldCloseButton onClose={close} />
            </span>
        </div>
    );
}

// The tab's close: a press-and-hold (FR-SHELL-025), shown under the pointer.
function HoldCloseButton({ onClose }: { onClose: () => void }) {
    return (
        <HoldToCloseButton
            className="relative flex h-[18px] w-[18px] cursor-pointer items-center justify-center p-0"
            onClose={() => onClose()}
        />
    );
}

// Dragging a temporary view up or down reorders it; out of the sidebar, onto the panels, it joins the view on screen
// (#414), as a tab dragged out of the tab bar did.
function useRowDrag(listRef: React.RefObject<HTMLDivElement>, asideRef: React.RefObject<HTMLElement>, ids: string[]) {
    const ws = useAtomValue(atoms.workspace);
    const [state, setState] = useState<{ id: string; before: string; out: boolean }>(null);
    const suppressClickRef = useRef(false);
    const idsRef = useRef(ids);
    idsRef.current = ids;
    const wsRef = useRef(ws);
    wsRef.current = ws;
    const onMouseDown = (e: React.MouseEvent, tabId: string) => {
        if (e.button !== 0) {
            return;
        }
        const startX = e.clientX;
        const startY = e.clientY;
        let started = false;
        let before: string = null;
        let out = false;
        const rowsOf = () =>
            Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-testid='sidebar-view-row']") ?? []).map(
                (el) => {
                    const r = el.getBoundingClientRect();
                    return { id: el.dataset.tabId, top: r.top, height: r.height };
                }
            );
        const onMove = (ev: MouseEvent) => {
            if (!started) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DragThresholdPx) {
                    return;
                }
                started = true;
            }
            const right = asideRef.current?.getBoundingClientRect().right ?? Infinity;
            out = trackTabPanelDrag(
                ev,
                tabId,
                asideRef.current,
                () => {},
                (p) => p.clientX > right
            );
            before = out ? null : dropTargetAt(ev.clientY, rowsOf());
            setState({ id: tabId, before, out });
        };
        const onUp = (ev: MouseEvent) => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            setState(null);
            if (!started) {
                return;
            }
            suppressClickRef.current = true;
            if (finishTabPanelDrag(ev) || out) {
                return;
            }
            const current = idsRef.current;
            const target = before ?? null;
            if (target === tabId || (target == null && current[current.length - 1] === tabId)) {
                return;
            }
            const workspace = wsRef.current;
            const all = moveTabBefore(visibleOrder(workspace), tabId, target ?? afterLastTemporary(workspace, current));
            fireAndForget(() => RpcApi.UpdateWorkspaceTabIdsCommand(TabRpcClient, workspace.oid, all));
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    };
    const takeClick = () => {
        const taken = suppressClickRef.current;
        suppressClickRef.current = false;
        return taken;
    };
    return { state, drag: { onMouseDown, takeClick } as RowDrag };
}

function visibleOrder(ws: Workspace): string[] {
    const hidden = new Set<string>((ws?.meta as Record<string, any>)?.["molten:hiddentabs"] ?? []);
    return (ws?.tabids ?? []).filter((id) => !hidden.has(id));
}

// The tab a view dropped after the last temporary row lands before: the one following it in the workspace's order.
function afterLastTemporary(ws: Workspace, temporary: string[]): string {
    const order = visibleOrder(ws);
    const last = temporary[temporary.length - 1];
    const at = order.indexOf(last);
    return at >= 0 && at + 1 < order.length ? order[at + 1] : null;
}

function TemporaryViews({
    ids,
    activeTabId,
    asideRef,
}: {
    ids: string[];
    activeTabId: string;
    asideRef: React.RefObject<HTMLElement>;
}) {
    const t = useT();
    const listRef = useRef<HTMLDivElement>(null);
    const { state, drag } = useRowDrag(listRef, asideRef, ids);
    const newViewKeys = formatShortcutById("new-tab");
    return (
        <div className="flex shrink-0 flex-col" data-testid="sidebar-temporary">
            <div
                className="flex items-center gap-1.5 px-1 pt-1.5 pb-0.5 text-11 tracking-[0.07em] text-muted uppercase"
                title={t("sidebar.temporary.hint")}
            >
                <span>{t("sidebar.temporary.title")}</span>
            </div>
            <div ref={listRef} className="flex flex-col gap-px">
                {ids.map((id) => (
                    <ViewRow
                        key={id}
                        tabId={id}
                        active={id === activeTabId}
                        dragging={state?.id === id}
                        dropBefore={state != null && !state.out && state.before === id && state.id !== id}
                        drag={drag}
                    />
                ))}
                <button
                    type="button"
                    className="mt-sb-row relative flex min-h-[30px] w-full shrink-0 cursor-pointer items-center gap-2 rounded-6 px-2 text-left text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-white/[0.08] hover:text-primary"
                    data-testid="sidebar-new-view"
                    onClick={() => getApi().createTab()}
                >
                    {state != null && !state.out && state.before == null && state.id !== ids[ids.length - 1] ? (
                        <span className="pointer-events-none absolute -top-px right-1 left-1 h-[2px] rounded-full bg-accent" />
                    ) : null}
                    <span className="flex w-4 shrink-0 justify-center">
                        <SidebarGlyph name="plus" size={14} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{t("sidebar.temporary.newView")}</span>
                    {newViewKeys ? (
                        <span className="mt-sb-row-hint font-mono text-11 text-muted">{newViewKeys}</span>
                    ) : null}
                </button>
            </div>
        </div>
    );
}

// The status bar's left part, on one line: the focused pane's tree, branch, CI and pull request.
function BranchSection() {
    const t = useT();
    const { pane, tree, probe } = useFocusedPane();
    return (
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden" data-testid="sidebar-branch">
            {probe}
            {pane ? <WorktreeChip marker={tree} hideBranch={true} /> : null}
            {pane?.branch ? (
                <button
                    type="button"
                    className={cn(ItemButton, "gap-[5px] px-0.5")}
                    title={`${pane.projectName}\n${pane.branchTitle}`}
                    onClick={() => fireAndForget(openProjectOverview)}
                >
                    <SidebarGlyph name="branch" size={12} />
                    <span className="truncate">{pane.branch}</span>
                    {pane.ahead > 0 ? <span className="text-muted">↑{pane.ahead}</span> : null}
                    {pane.dirty ? <span className="text-warning">●</span> : null}
                </button>
            ) : pane ? (
                <span className="truncate" title={pane.projectTitle}>
                    {pane.projectName}
                </span>
            ) : null}
            {pane?.ci ? (
                <button
                    type="button"
                    className={cn(ItemButton, "shrink-0 px-0.5")}
                    title={t("status.ci.title", { label: pane.ci.label })}
                    aria-label={t("status.ci.title", { label: pane.ci.label })}
                    onClick={() => fireAndForget(() => openMoltentermView(MoltentermCicdView))}
                >
                    {pane.ci.status === "running" ? (
                        <DominoLoader className="text-accent" />
                    ) : (
                        <i className={cn("fa fa-solid text-11", pane.ci.iconClass)} />
                    )}
                </button>
            ) : null}
            {pane?.pr ? (
                <button
                    type="button"
                    className={cn(ItemButton, "shrink-0 px-0.5")}
                    title={t(pane.pr.draft ? "status.pr.draft" : "status.pr.open", { title: pane.pr.title })}
                    onClick={() => fireAndForget(() => openWebLink(pane.pr.url))}
                >
                    #{pane.pr.number}
                </button>
            ) : null}
        </span>
    );
}

function BranchLine() {
    const t = useT();
    const view = useStatusBarView();
    return (
        <div className="flex shrink-0 items-center justify-between gap-2 pr-1 pl-1.5 font-mono text-11 whitespace-nowrap text-muted">
            <BranchSection />
            <span className="flex shrink-0 items-center gap-1 font-sans">
                <UpdateStatusBanner />
                <GoldUpdateButton />
                <ReleaseUpdateButton />
                <button
                    type="button"
                    title={`${view.tooltip}\n\n${t("status.build.releaseNotes")}`}
                    aria-label={t("status.build.badgeLabel", { badge: view.badge })}
                    data-testid="build-badge"
                    onClick={() => ReleaseNotesModel.getInstance().open()}
                    className={cn(
                        "mt-sb-build inline-flex h-[18px] w-5 shrink-0 cursor-pointer items-center justify-center rounded-4 border-[1.5px] bg-transparent font-mono text-11 font-semibold",
                        ChannelClasses[view.channel]
                    )}
                >
                    {t(buildLetterKey(view.channel))}
                </button>
            </span>
        </div>
    );
}

type DotDrag = {
    // How far the dragged dot is drawn from its slot; null when it is not dragged.
    offsetX: number;
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
    takeClick: () => boolean;
    onMoveKey: (direction: -1 | 1) => void;
};

function WorkspaceDot({
    entry,
    workspaces,
    unread,
    drag,
}: {
    entry: WorkspaceRailEntry;
    workspaces: SidebarWorkspaces;
    unread: number;
    drag: DotDrag;
}) {
    const t = useT();
    const tc = useTCount();
    const platform = usePlatform();
    const [workspace] = useWaveObjectValue<Workspace>(makeORef("workspace", entry.id));
    const agent = useAtomValue(AgentStates.getInstance().workspaceAtom(entry.id));
    const coffee = useAtomValue(KeepAwakeModel.getInstance().coffeeAtom(entry.id));
    const choice = workspace?.color ?? entry.color;
    const stops = colourStops(choice);
    const paint = stops.length > 0 ? colourChoiceCss(choice) : "var(--color-secondary)";
    const ringColour = stops[0] ?? "var(--color-secondary)";
    const letterColour = stops.length > 0 ? colourChoiceForeground(choice) : "black";
    const waiting = agent?.state === "waiting";
    const ring = !entry.active && (unread > 0 || waiting);
    const letter = (Array.from(entry.name ?? "")[0] ?? "").toUpperCase();
    const parts = [entry.name];
    if (unread > 0) {
        parts.push(tc("rail.unread", unread));
    }
    if (waiting) {
        parts.push(agentStateTitle(agent));
    }
    if (coffee != null) {
        parts.push(t("rail.keptAwake", { condition: coffeeCondition(coffee, Date.now()) }));
    }
    const label = parts.join(" · ");
    const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (drag.takeClick()) {
            return;
        }
        if (!entry.active) {
            getApi().switchWorkspace(entry.id);
            return;
        }
        if (!entry.saved) {
            openWorkspaceEditor(entry.id, e.currentTarget);
        }
    };
    return (
        <button
            type="button"
            role="tab"
            aria-selected={entry.active}
            aria-label={label}
            title={label}
            data-testid="sidebar-workspace-dot"
            data-workspace-id={entry.id}
            className={cn(
                "mt-sb-dot relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0",
                entry.active && "is-on",
                ring && "has-ring",
                drag.offsetX != null && "z-10"
            )}
            style={
                {
                    ["--mt-sb-dot-colour" as string]: ringColour,
                    transform: drag.offsetX != null ? `translateX(${drag.offsetX}px)` : undefined,
                } as React.CSSProperties
            }
            onClick={onClick}
            onPointerDown={entry.saved ? drag.onPointerDown : undefined}
            onKeyDown={(e) => {
                const direction = dotMoveKey(e);
                if (direction == null || !entry.saved) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                drag.onMoveKey(direction);
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                if (!entry.saved) {
                    return;
                }
                const anchor = e.currentTarget;
                showMenuUnder(anchor, workspaceMenuItems(entry, workspaces, anchor, platform, t));
            }}
        >
            <i className="font-semibold" style={{ background: paint, color: letterColour }}>
                {entry.active ? letter : null}
            </i>
        </button>
    );
}

function moveWorkspaceDot(move: RailMove, refocus: boolean) {
    if (move == null) {
        return;
    }
    fireAndForget(async () => {
        try {
            await moveWorkspace(move);
        } catch (err) {
            console.log("moving a workspace dot:", err);
        }
        if (refocus) {
            requestAnimationFrame(() =>
                document
                    .querySelector<HTMLElement>(
                        `[data-testid='sidebar-workspace-dot'][data-workspace-id="${CSS.escape(move.workspaceid)}"]`
                    )
                    ?.focus()
            );
        }
    });
}

// The rail's reorder, on the dots (FR-MC-031): drag a dot sideways, or ⌥⇧ and an arrow on the focused one. wavesrv keeps
// the order and sorts the list by it.
function WorkspaceDots({ workspaces }: { workspaces: SidebarWorkspaces }) {
    const t = useT();
    const notifications = useAtomValue(MoltentermNotifications.getInstance().shownEntriesAtom);
    const unread = unreadByWorkspace(notifications);
    const rowRef = useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = useState<{ id: string; offsetX: number }>(null);
    const suppressClickRef = useRef<string>(null);
    const savedIdsRef = useRef(workspaces.savedIds);
    savedIdsRef.current = workspaces.savedIds;
    const startDrag = (id: string) => (e: React.PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0) {
            return;
        }
        const startX = e.clientX;
        let started = false;
        const centres = Array.from(
            rowRef.current?.querySelectorAll<HTMLElement>("[data-testid='sidebar-workspace-dot']") ?? []
        )
            .filter((el) => savedIdsRef.current.includes(el.dataset.workspaceId))
            .map((el) => {
                const r = el.getBoundingClientRect();
                return { id: el.dataset.workspaceId, x: r.left + r.width / 2 };
            });
        const onMove = (ev: PointerEvent) => {
            if (!started && Math.abs(ev.clientX - startX) < DragThresholdPx) {
                return;
            }
            started = true;
            setDragging({ id, offsetX: ev.clientX - startX });
        };
        const onUp = (ev: PointerEvent) => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            setDragging(null);
            if (!started) {
                return;
            }
            suppressClickRef.current = id;
            const own = centres.find((c) => c.id === id);
            const slot = dotDropSlot(centres, id, (own?.x ?? startX) + ev.clientX - startX);
            moveWorkspaceDot(slotMove(savedIdsRef.current, id, slot), false);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
    };
    const dragOf = (id: string): DotDrag => ({
        offsetX: dragging?.id === id ? dragging.offsetX : null,
        onPointerDown: startDrag(id),
        takeClick: () => {
            const taken = suppressClickRef.current === id;
            suppressClickRef.current = null;
            return taken;
        },
        onMoveKey: (direction) => moveWorkspaceDot(neighbourMove(savedIdsRef.current, id, direction), true),
    });
    return (
        <div
            ref={rowRef}
            role="tablist"
            aria-label={t("rail.workspaces")}
            className="flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-hidden"
            data-testid="sidebar-workspace-dots"
        >
            {workspaces.entries.map((entry) => (
                <WorkspaceDot
                    key={entry.id}
                    entry={entry}
                    workspaces={workspaces}
                    unread={unread.get(entry.id) ?? 0}
                    drag={dragOf(entry.id)}
                />
            ))}
        </div>
    );
}

const SettingsView = "waveconfig";

// Today's equivalent of the library (#1192 builds it): the tools of the rail, Sessions, Pilotage, the widgets, apps,
// tips and settings.
function LibraryButton() {
    const t = useT();
    const env = useWaveEnv<SidebarEnv>();
    const fullConfig = useAtomValue(env.atoms.fullConfigAtom);
    const hasConfigErrors = useAtomValue(env.atoms.hasConfigErrors);
    const workspaceId = useAtomValue(env.atoms.workspaceId);
    const workspace = useAtomValue(atoms.workspace);
    const sessions = useAtomValue(DurableSessions.getInstance().badgeAtom);
    const dir = readWorkspaceProject(workspace).dir;
    useReviewsRailWatch(dir);
    const answer = useListedReviewsAnswer(dir);
    const readied = useAtomValue(ReviewsModel.getInstance().readiedAtom);
    const [menuOpen, setMenuOpen] = useState(false);
    const [appsOpen, setAppsOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const showApps = env.isDev() || (fullConfig?.settings?.["feature:waveappbuilder"] ?? false);
    const label = t("sidebar.library.label");
    const createBlock = (blockdef: BlockDef, magnified = false, ephemeral = false) =>
        fireAndForget(() => env.createBlock(blockdef, magnified, ephemeral));
    const openMenu = () => {
        const widgets = railCustomWidgets(fullConfig?.widgets, workspaceId);
        const tools = t("sidebar.library.tools");
        const items: ContextMenuItem[] = [
            {
                label: sessions.label,
                icon: "layer-group",
                section: tools,
                click: () => fireAndForget(() => toggleMoltentermView(MoltentermSessionsView)),
            },
            {
                label: reviewsRailLabel(reviewCounts(answer, readied)),
                icon: "code-pull-request",
                section: tools,
                click: () =>
                    fireAndForget(() =>
                        toggleMoltentermView(MoltentermReviewsView, async () => {
                            await ReviewsModel.getInstance().openReviews();
                        })
                    ),
            },
        ];
        const widgetSection = t("sidebar.library.widgets");
        for (const widget of widgets) {
            items.push({
                label: widget.label || railWidgetTooltip(widget),
                icon: widget.icon || "browser",
                section: widgetSection,
                click: () => createBlock(widget.blockdef, widget.magnified),
            });
        }
        items.push({
            label: t("rail.tools.editWidgets"),
            icon: "pen",
            section: widgetSection,
            click: () => createBlock({ meta: { view: "waveconfig", file: "widgets.json" } }, false, true),
        });
        if (showApps) {
            items.push({
                label: t("rail.tools.apps"),
                icon: "cube",
                section: widgetSection,
                click: () => setAppsOpen(true),
            });
        }
        items.push(
            { type: "separator" },
            {
                label: t("rail.tools.tips"),
                icon: "lightbulb",
                click: () =>
                    fireAndForget(() =>
                        toggleMoltentermView(MoltentermTipsView, async () => {
                            await env.createBlock({ meta: { view: MoltentermTipsView } }, false, true);
                        })
                    ),
            },
            {
                label: t(hasConfigErrors ? "rail.tools.settingsErrors" : "rail.tools.settings"),
                icon: "gear",
                click: () =>
                    fireAndForget(() =>
                        toggleMoltentermView(SettingsView, async () => {
                            await env.createBlock({ meta: { view: SettingsView } }, false, true);
                        })
                    ),
            }
        );
        setMenuOpen(true);
        showMenuUnder(buttonRef.current, items, () => setMenuOpen(false));
    };
    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                className={IconButton}
                aria-label={label}
                title={label}
                aria-expanded={menuOpen}
                data-testid="sidebar-library"
                onClick={openMenu}
            >
                <SidebarGlyph name="lib" />
                {sessions.count > 0 || hasConfigErrors ? (
                    <span
                        className={cn(
                            "absolute top-1 right-1 h-2 w-2 rounded-full ring-2 ring-[var(--color-background)]",
                            hasConfigErrors ? "bg-error" : "bg-[var(--mt-state-working)]"
                        )}
                        aria-hidden
                    />
                ) : null}
            </button>
            {showApps && buttonRef.current != null ? (
                <AppsFloatingWindow
                    isOpen={appsOpen}
                    onClose={() => setAppsOpen(false)}
                    referenceElement={buttonRef.current}
                    placement="right-end"
                />
            ) : null}
        </>
    );
}

// Today's create actions: a new view (the tab bar's +) and a new workspace (the rail's +).
function PlusButton() {
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const [open, setOpen] = useState(false);
    const label = t("sidebar.plus.label");
    const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        const name = workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace");
        const items: ContextMenuItem[] = [
            {
                label: t("sidebar.plus.newView"),
                icon: "plus",
                section: t("sidebar.plus.inWorkspace", { name }),
                accelerator: acceleratorById("new-tab"),
                click: () => getApi().createTab(),
            },
            {
                label: t("sidebar.plus.newWorkspace"),
                icon: "layer-group",
                section: t("sidebar.plus.everywhere"),
                click: () => getApi().createWorkspace(),
            },
        ];
        setOpen(true);
        showMenuUnder(e.currentTarget, items, () => setOpen(false));
    };
    return (
        <button
            type="button"
            className={cn(IconButton, "mt-sb-plus")}
            aria-label={label}
            title={label}
            aria-expanded={open}
            data-testid="sidebar-plus"
            onClick={onClick}
        >
            <SidebarGlyph name="plus" />
        </button>
    );
}

function WidthGrip({ width }: { width: number }) {
    const t = useT();
    const model = SidebarModel.getInstance();
    const [on, setOn] = useState(false);
    const startRef = useRef<{ x: number; width: number }>(null);
    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("sidebar.grip")}
            aria-valuemin={SidebarMinWidth}
            aria-valuemax={SidebarMaxWidth}
            aria-valuenow={width}
            tabIndex={0}
            title={t("sidebar.gripTitle", { width: SidebarDefaultWidth })}
            data-testid="sidebar-grip"
            className={cn("mt-sb-grip", on && "is-on")}
            onPointerDown={(e) => {
                if (e.button !== 0) {
                    return;
                }
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                startRef.current = { x: e.clientX, width };
                setOn(true);
            }}
            onPointerMove={(e) => {
                const start = startRef.current;
                if (start == null) {
                    return;
                }
                model.dragWidth(start.width + e.clientX - start.x);
            }}
            onPointerUp={(e) => {
                const start = startRef.current;
                startRef.current = null;
                setOn(false);
                if (start == null || e.clientX === start.x) {
                    return;
                }
                model.commitWidth(start.width + e.clientX - start.x);
            }}
            onPointerCancel={() => {
                startRef.current = null;
                setOn(false);
                model.commitWidth(width);
            }}
            onDoubleClick={() => model.resetWidth()}
            onKeyDown={(e) => {
                const step = e.key === "ArrowLeft" ? -8 : e.key === "ArrowRight" ? 8 : 0;
                if (step === 0) {
                    return;
                }
                e.preventDefault();
                model.commitWidth(width + step);
            }}
        />
    );
}

// What lives once per window with the sidebar: the rail's dialogs and keepers, the release notes, 360 view's message.
function SidebarHosts({ entries }: { entries: WorkspaceRailEntry[] }) {
    return (
        <>
            <WorkspaceRailHosts entries={entries} />
            <ReleaseNotesHost />
            <View360ExitHost />
        </>
    );
}

export function WorkspaceSidebar() {
    const t = useT();
    const model = SidebarModel.getInstance();
    const width = useAtomValue(model.widthAtom);
    const hidden = useAtomValue(model.hiddenAtom);
    const peek = useAtomValue(model.peekAtom);
    const ws = useAtomValue(atoms.workspace);
    const activeTabId = useAtomValue(atoms.staticTabId);
    const workspaces = useSidebarWorkspaces();
    const asideRef = useRef<HTMLElement>(null);
    const peekTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
    const split = useAtomValue(model.tabSplitAtom);
    useEffect(() => () => clearTimeout(peekTimerRef.current), []);
    const name = workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace");
    const keepPeek = () => clearTimeout(peekTimerRef.current);
    const endPeek = () => {
        if (!hidden) {
            return;
        }
        clearTimeout(peekTimerRef.current);
        peekTimerRef.current = setTimeout(() => model.setPeek(false), 280);
    };
    return (
        <>
            {hidden ? (
                <div
                    className="mt-sb-edge"
                    data-testid="sidebar-edge"
                    onMouseEnter={() => {
                        keepPeek();
                        model.setPeek(true);
                    }}
                    onClick={() => model.setPeek(true)}
                />
            ) : null}
            <aside
                ref={asideRef}
                aria-label={t("sidebar.label", { name })}
                data-testid="workspace-sidebar"
                data-hidden={hidden ? "true" : undefined}
                className={cn(
                    "mt-sb flex h-full shrink-0 flex-col gap-2 select-none",
                    hidden ? "is-hidden" : "pb-2 pl-2",
                    hidden && peek && "is-peek"
                )}
                style={{ width }}
                onMouseEnter={keepPeek}
                onMouseLeave={endPeek}
            >
                <WindowRow leftInset={hidden ? 18 : 8} />
                <div className="mt-sb-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                    <WorkspaceHeader workspaces={workspaces} />
                    <TileGrid
                        tileIds={split.tiles}
                        activeTabId={activeTabId}
                        label={t("sidebar.tiles.label", { name })}
                    />
                    <TemporaryViews ids={split.temporary} activeTabId={activeTabId} asideRef={asideRef} />
                </div>
                <BranchLine />
                <div className="flex shrink-0 items-center gap-1.5 border-t border-white/10 pt-1.5">
                    <LibraryButton />
                    <WorkspaceDots workspaces={workspaces} />
                    <PlusButton />
                </div>
            </aside>
            {hidden ? null : <WidthGrip width={width} />}
            <SidebarHosts entries={workspaces.entries} />
        </>
    );
}
