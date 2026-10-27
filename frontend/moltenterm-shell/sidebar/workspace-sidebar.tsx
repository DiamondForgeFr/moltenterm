// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace sidebar (FR-SHELL-079, DS-SHELL-123, DS-SHELL-124): each workspace's own column on the left, in place
// of the tab bar, the workspace rail and the status bar. Top to bottom: the window row (sidebar toggle; keep-awake and
// notifications), the top field (FR-SHELL-083, top-field.tsx), the top row (views pinned everywhere, FR-SHELL-080),
// the workspace header (name, project type, its menu on hover), the tiles (pinned tabs), the temporary views (the
// other tabs, New view), the branch and build line, and the bottom bar (library, workspace dots, +).
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
import { UpdateStatusBanner } from "@/app/tab/updatebanner";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { AppsFloatingWindow, type WidgetsEnv } from "@/app/workspace/widgets";
import { deleteLayoutModelForTab } from "@/layout/index";
import { validateCssColor } from "@/util/color-validator";
import { isMacOS, isMacOSTahoeOrLater } from "@/util/platformutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentStateTitle } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { HoldToCloseButton } from "../hold-to-close";
import { useT, useTCount } from "../i18n/i18n";
import { coffeeCondition, coffeeSupported } from "../keepawake-model";
import { KeepAwakeModel } from "../keepawake-store";
import { KeepAwakeStatusItem, usePlatform } from "../keepawake-ui";
import { MoltentermCicdView } from "../mission/cicd-view";
import { MoltenWave } from "../molten-button";
import { NotificationCenter } from "../notification-center";
import { unreadByWorkspace } from "../notifications-model";
import { MoltentermNotifications } from "../notifications-store";
import { openMoltentermView, toggleMoltentermView } from "../open-view";
import { openWebLink } from "../open-web-link";
import { ProjectTabMetaKey } from "../project/project-model";
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
import { reopenLastClosed } from "../reopen/reopen-store";
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
import { View360ExitHost } from "../view360/view360-toggle";
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
import { PrPips, useCountsMotion, usePilotageBlock, useWorkspacePrCounts } from "./pr-counts";
import { hasPrCounts, PrCounts } from "./pr-counts-model";
import {
    finishDrop,
    keyProps,
    setDrag,
    SidebarDrag,
    sidebarDragAtom,
    startBlockDrag,
    takeDragClick,
    usableHit,
    useGlide,
    zoneAt,
    ZoneHit,
    zoneProps,
} from "./sidebar-drag";
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
import { undoFromKey } from "./sidebar-undo";
import "./sidebar.css";
import { TopField } from "./top-field";
import { TopFieldModel } from "./top-field-store";
import { useTopGlyph, ViewGlyph, viewGlyphAtom } from "./view-glyph";
import { viewMenuItems, ViewMenuTarget } from "./view-menu";
import { dropAction, DropZone, readViewIcon, ViewIconMetaKey, zoneCaptionShown } from "./view-menu-model";
import { GlobalPin, GlobalPinMetaKey, PinScope, ViewState } from "./view-pins-model";
import { PinDraft, ViewPins } from "./view-pins-store";
import { ViewPopoverHost } from "./view-popover";

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

// What the view menu needs of a view (FR-SHELL-080, FR-SHELL-081): its state, whether it changed since pinned, its
// shown name and the icon the developer chose (its pin's for a view pinned everywhere).
type ViewPinFacts = { state: ViewState; modified: boolean; name: string; icon: string };

function useViewPin(tabId: string, tab: Tab, name: string): ViewPinFacts {
    const pins = ViewPins.getInstance();
    const state = useAtomValue(pins.stateAtom(tabId));
    const modified = useAtomValue(pins.modifiedAtom(tabId));
    const globalPins = useAtomValue(pins.globalPinsAtom);
    const meta = (tab?.meta ?? {}) as Record<string, any>;
    const pin = state === "everywhere" ? globalPins.find((p) => p.id === meta[GlobalPinMetaKey]) : null;
    const icon = readViewIcon(pin != null ? pin.icon : meta[ViewIconMetaKey]);
    return { state, modified, name: pin?.name ?? name, icon };
}

// The view's menu (FR-SHELL-081) and its close. startRename: the view's own field (a row's or a tile's).
function useViewActions(
    tabId: string,
    active: boolean,
    pin: ViewPinFacts,
    startRename: () => void,
    projectTab?: boolean
) {
    const env = useWaveEnv<SidebarEnv>();
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const confirmClose = useAtomValue(env.getSettingsKeyAtom("tab:confirmclose")) ?? false;
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
        const target: ViewMenuTarget = { ref: { tabId }, ...pin, active, projectTab };
        env.showContextMenu(
            viewMenuItems(target, { startRename, onClose: close, env, at: { x: e.clientX, y: e.clientY } }, t),
            e
        );
    };
    return { env, close, onContextMenu };
}

// The rename-tab shortcut (and the tab model's rename) opens the view's own field.
function useRenameCallback(tabId: string, env: SidebarEnv, start: () => void) {
    const tabModel = getTabModelByTabId(tabId, env);
    useEffect(() => {
        tabModel.startRenameCallback = start;
        return () => {
            if (tabModel.startRenameCallback === start) {
                tabModel.startRenameCallback = null;
            }
        };
    }, [tabModel, start]);
}

function dropSideClass(drag: SidebarDrag, zone: DropZone, key: string): string {
    if (drag == null || drag.zone !== zone || drag.key !== key || drag.id === key) {
        return null;
    }
    if (dropAction(drag.kind, zone) !== (zone === "tiles" ? "reorder-tiles" : "reorder-top")) {
        return null;
    }
    return drag.after ? "mt-sb-dropa" : "mt-sb-dropb";
}

function Tile({ tabId, active, counts }: { tabId: string; active: boolean; counts?: PrCounts }) {
    const [tab] = useWaveObjectValue<Tab>(makeORef("tab", tabId));
    const hasCounts = hasPrCounts(counts);
    const { grow } = useCountsMotion(`tile:${tabId}`, hasCounts);
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const drag = useAtomValue(sidebarDragAtom);
    const glyph = useAtomValue(viewGlyphAtom(tabId));
    const pin = useViewPin(tabId, tab, identity.name);
    const [renaming, setRenaming] = useState(false);
    const startRename = useCallback(() => setRenaming(true), []);
    const projectTab = !!(tab?.meta as Record<string, any>)?.[ProjectTabMetaKey];
    const { env, onContextMenu } = useViewActions(tabId, active, pin, startRename, projectTab);
    useRenameCallback(tabId, env, startRename);
    const modified = pin.state === "workspace" && pin.modified;
    const workspace = workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace");
    const title = renaming
        ? undefined
        : modified
          ? t("sidebar.pins.tileModifiedTitle", { name: identity.name, workspace })
          : pin.state === "workspace"
            ? t("sidebar.pins.tileTitle", { name: identity.name, workspace })
            : identity.name;
    const rename = (name: string) => {
        setRenaming(false);
        if (name !== identity.name) {
            fireAndForget(() => ViewPins.getInstance().rename({ tabId }, name));
        }
    };
    const activate = () => {
        if (takeDragClick(tabId) || renaming) {
            return;
        }
        getApi().setActiveTab(tabId);
    };
    return (
        <div
            role="button"
            tabIndex={0}
            className={cn(
                "mt-sb-tile relative flex h-[52px] min-w-0 cursor-pointer flex-col items-center justify-center gap-[5px] rounded-6 px-1 text-11 text-primary transition-colors duration-120 ease-mt",
                active
                    ? "bg-white/20 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]"
                    : "bg-white/[0.09] hover:bg-white/15",
                hasCounts && "mt-sb-hp",
                hasCounts && grow && "mt-sb-grow",
                drag?.kind === "tile" && drag.id === tabId && "mt-sb-dragged",
                dropSideClass(drag, "tiles", tabId)
            )}
            aria-current={active ? "page" : undefined}
            title={title}
            data-testid="sidebar-tile"
            data-tab-id={tabId}
            data-modified={modified ? "true" : undefined}
            {...keyProps(tabId)}
            onClick={activate}
            onMouseDown={(e) => {
                if (!renaming) {
                    startBlockDrag(e, "tile", tabId, identity.name, !projectTab);
                }
            }}
            onKeyDown={(e) => {
                if (!renaming && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    getApi().setActiveTab(tabId);
                }
            }}
            onContextMenu={onContextMenu}
        >
            <ViewGlyph icons={glyph} />
            {renaming ? (
                <span className="flex w-full px-0.5">
                    <RenameInput initial={identity.name} onDone={rename} />
                </span>
            ) : (
                <span
                    className="name max-w-full truncate"
                    onDoubleClick={(e) => {
                        e.stopPropagation();
                        setRenaming(true);
                    }}
                >
                    {identity.name}
                </span>
            )}
            {hasCounts ? <PrPips counts={counts} motionKey={`tile:${tabId}`} calm={!grow} /> : null}
            {modified ? null : (
                <span className="absolute top-1.5 right-1.5 flex">
                    <TabAgentMark info={identity.agent} />
                </span>
            )}
            {modified ? (
                <>
                    <span className="mt-sb-modpip" data-testid="sidebar-modpip" aria-hidden />
                    <span
                        role="button"
                        tabIndex={0}
                        className="mt-sb-revert"
                        title={t("sidebar.pins.revertTitle")}
                        aria-label={t("sidebar.pins.revertTitle")}
                        data-testid="sidebar-revert"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            fireAndForget(() => ViewPins.getInstance().revert(tabId));
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                fireAndForget(() => ViewPins.getInstance().revert(tabId));
                            }
                        }}
                    >
                        <SidebarGlyph name="undo" size={12} />
                    </span>
                </>
            ) : null}
        </div>
    );
}

// A row of the sidebar that a drag can land on (FR-SHELL-081): its scope caption shows while the drop would pin the
// dragged view there; the row being reordered keeps it hidden.
function useZone(zone: DropZone): { drag: SidebarDrag; target: boolean; over: boolean } {
    const drag = useAtomValue(sidebarDragAtom);
    const target = drag != null && drag.pinnable && zoneCaptionShown(drag.kind, zone);
    return { drag, target, over: target && drag.zone === zone };
}

function TileGrid({ tileIds, activeTabId, label }: { tileIds: string[]; activeTabId: string; label: string }) {
    const counts = useWorkspacePrCounts();
    const pilotageTile = usePilotageBlock(tileIds.map((id) => ({ key: id, tabId: id })));
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const ref = useRef<HTMLDivElement>(null);
    const { target, over } = useZone("tiles");
    useGlide(ref, tileIds.join(" "));
    if (tileIds.length === 0 && !target) {
        return null;
    }
    const caption = t("sidebar.views.captionHere", { workspace: workspaceShownName(ws?.name, t) });
    return (
        <div
            ref={ref}
            className={cn(
                "mt-sb-zone grid shrink-0 gap-1.5 px-1 pt-[7px] pb-0.5",
                target && "is-target",
                over && "is-over",
                tileIds.length === 0 && "mt-sb-zone-empty"
            )}
            style={{ gridTemplateColumns: TileGridColumns }}
            aria-label={label}
            data-testid="sidebar-tiles"
            data-cap={caption}
            {...zoneProps("tiles")}
        >
            {tileIds.map((id) => (
                <Tile
                    key={id}
                    tabId={id}
                    active={id === activeTabId}
                    counts={id === pilotageTile ? counts : undefined}
                />
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
    const t = useT();
    const pin = useViewPin(tabId, tab, identity.name);
    const glyph = useAtomValue(viewGlyphAtom(tabId));
    const [renaming, setRenaming] = useState(false);
    const startRename = useCallback(() => setRenaming(true), []);
    const { env, close, onContextMenu } = useViewActions(tabId, active, pin, startRename);
    useRenameCallback(tabId, env, startRename);
    const badges = useAtomValue(getTabBadgeAtom(tabId, env));
    const trees = useTabTreesTooltip(tabId);
    const [hoverNow, setHoverNow] = useState(() => Date.now());
    const title = useTabTooltip(identity, trees.title, hoverNow);
    const flagColor = useFlagColor(tab);
    const rename = (name: string) => {
        setRenaming(false);
        if (name !== identity.name) {
            fireAndForget(() => ViewPins.getInstance().rename({ tabId }, name));
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
                dragging && "mt-sb-dragged"
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
            <ViewGlyph icons={glyph} small className="min-w-4 justify-center" />
            {renaming ? (
                <RenameInput initial={identity.name} onDone={rename} />
            ) : (
                // "name": the chip of a drag onto the panels reads the shown name there (tabName in drop-zones.ts).
                <span
                    className="name min-w-0 shrink truncate"
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
                <button
                    type="button"
                    className="flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-4 text-secondary hover:bg-white/[0.12] hover:text-primary"
                    title={t("sidebar.pins.pinTitle")}
                    aria-label={t("sidebar.pins.pinTitle")}
                    data-testid="sidebar-pin-view"
                    onClick={(e) => {
                        e.stopPropagation();
                        ViewPins.getInstance().openPinPage(tabId, identity.name);
                    }}
                >
                    <SidebarGlyph name="pin" size={12} />
                </button>
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
        let hit: ZoneHit = null;
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
            // Over the tiles or the top row, the view would be pinned there (FR-SHELL-081).
            hit = out ? null : usableHit("row", zoneAt(ev.clientX, ev.clientY), true);
            before = out || hit != null ? null : dropTargetAt(ev.clientY, rowsOf());
            setState({ id: tabId, before, out: out || hit != null });
            setDrag({
                kind: "row",
                id: tabId,
                zone: hit?.zone ?? null,
                key: hit?.key ?? null,
                after: hit?.after ?? false,
                pinnable: true,
            });
        };
        const onUp = (ev: MouseEvent) => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            setState(null);
            setDrag(null);
            if (!started) {
                return;
            }
            suppressClickRef.current = true;
            if (finishTabPanelDrag(ev) || out) {
                return;
            }
            if (hit != null) {
                finishDrop("row", tabId, hit, rowName(listRef.current, tabId));
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

// The name a row shows (its tab's name, or its first panel's title), for the toast of a pin by drag.
function rowName(list: HTMLElement, tabId: string): string {
    const row = list?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabId)}"] .name`);
    return row?.textContent ?? "";
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
                <CloseFinishedButton />
            </div>
        </div>
    );
}

// "Close the N finished views" (FR-SHELL-080): only while a temporary view's agents have all finished; a view whose
// agent works or waits stays open.
function CloseFinishedButton() {
    const t = useT();
    const tc = useTCount();
    const finished = useAtomValue(ViewPins.getInstance().finishedAtom);
    if (finished.length === 0) {
        return null;
    }
    return (
        <button
            type="button"
            className="mt-0.5 flex cursor-pointer items-center gap-1.5 rounded-6 border border-dashed border-white/[0.18] px-2 py-1.5 text-left text-12 text-secondary transition-colors duration-120 ease-mt hover:border-accent hover:text-primary"
            title={t("sidebar.pins.closeFinishedTitle")}
            data-testid="sidebar-close-finished"
            onClick={() => fireAndForget(() => ViewPins.getInstance().closeFinished())}
        >
            <SidebarGlyph name="x" size={14} />
            <span className="min-w-0 truncate">{tc("sidebar.pins.closeFinished", finished.length)}</span>
        </button>
    );
}

// The top row (FR-SHELL-080): the views pinned everywhere, the same blocks in every workspace; each opens this
// workspace's own instance, on its project. Nothing pinned everywhere: the row takes no room, except as a drop target
// while a view is dragged (FR-SHELL-081). Its blocks reorder by drag, the same in every workspace.
function TopRow({ instances, activeTabId }: { instances: Record<string, string>; activeTabId: string }) {
    const t = useT();
    const pins = useAtomValue(ViewPins.getInstance().globalPinsAtom);
    const workspaceId = useAtomValue(atoms.workspace)?.oid ?? "";
    const counts = useWorkspacePrCounts();
    // A view not yet opened in this workspace shows what its configuration names, as it will open.
    const pilotagePin = usePilotageBlock(
        pins.map((pin) => ({
            key: pin.id,
            tabId: instances[pin.id] ?? "",
            configViews: (pin.config?.panes ?? []).map((pane) => (pane?.view as string) ?? ""),
        }))
    );
    const ref = useRef<HTMLDivElement>(null);
    const { target, over } = useZone("top");
    useGlide(ref, pins.map((p) => p.id).join(" "));
    if (pins.length === 0 && !target) {
        return null;
    }
    return (
        <div
            ref={ref}
            className={cn(
                "mt-sb-zone grid shrink-0 gap-1.5",
                target && "is-target",
                over && "is-over",
                pins.length === 0 && "mt-sb-zone-empty"
            )}
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(max(40px, calc((100% - 18px) / 4)), 1fr))" }}
            aria-label={t("sidebar.pins.topRowLabel")}
            data-testid="sidebar-top-row"
            data-cap={t("sidebar.views.captionEverywhere")}
            {...zoneProps("top")}
        >
            {pins.map((pin) => (
                <TopRowBlock
                    key={pin.id}
                    pin={pin}
                    tabId={instances[pin.id] ?? ""}
                    active={!!instances[pin.id] && instances[pin.id] === activeTabId}
                    counts={pin.id === pilotagePin ? counts : undefined}
                    motionKey={`top:${pin.id}:${workspaceId}`}
                />
            ))}
        </div>
    );
}

function TopRowBlock({
    pin,
    tabId,
    active,
    counts,
    motionKey,
}: {
    pin: GlobalPin;
    tabId: string;
    active: boolean;
    counts?: PrCounts;
    motionKey: string;
}) {
    const t = useT();
    const hasCounts = hasPrCounts(counts);
    const { grow } = useCountsMotion(motionKey, hasCounts);
    const env = useWaveEnv<SidebarEnv>();
    const pins = ViewPins.getInstance();
    const drag = useAtomValue(sidebarDragAtom);
    const modified = useAtomValue(pins.modifiedAtom(tabId));
    const glyph = useTopGlyph(pin, tabId);
    const title = t(modified && tabId ? "sidebar.pins.topModifiedTitle" : "sidebar.pins.topTitle", { name: pin.name });
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const target: ViewMenuTarget = {
            ref: { tabId: tabId || undefined, pinId: pin.id },
            state: "everywhere",
            modified: !!tabId && modified,
            name: pin.name,
            icon: readViewIcon(pin.icon),
            active,
        };
        env.showContextMenu(viewMenuItems(target, { env, at: { x: e.clientX, y: e.clientY } }, t), e);
    };
    return (
        <button
            type="button"
            className={cn(
                "relative flex h-[34px] min-w-0 cursor-pointer items-center justify-center overflow-hidden rounded-6 px-1 text-primary transition-colors duration-120 ease-mt",
                active
                    ? "bg-white/20 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]"
                    : "bg-white/[0.07] hover:bg-white/[0.14]",
                hasCounts && "mt-sb-hp",
                hasCounts && grow && "mt-sb-grow",
                drag?.kind === "top" && drag.id === pin.id && "mt-sb-dragged",
                dropSideClass(drag, "top", pin.id)
            )}
            aria-label={pin.name}
            aria-current={active ? "page" : undefined}
            title={title}
            data-testid="sidebar-top-block"
            data-pin-id={pin.id}
            data-tab-id={tabId || undefined}
            {...keyProps(pin.id)}
            onMouseDown={(e) => startBlockDrag(e, "top", pin.id, pin.name)}
            onClick={() => {
                if (takeDragClick(pin.id)) {
                    return;
                }
                fireAndForget(() => pins.openGlobalPin(pin.id, tabId));
            }}
            onContextMenu={onContextMenu}
        >
            <ViewGlyph icons={glyph} small={glyph.length > 1} />
            {hasCounts ? <PrPips counts={counts} motionKey={motionKey} calm={!grow} small /> : null}
            {modified && tabId ? <span className="mt-sb-modpip" data-testid="sidebar-modpip" aria-hidden /> : null}
        </button>
    );
}

// The pin page (FR-SHELL-080): the view's name, and the two scopes in plain words. It takes the place of the
// workspace's lists until the view is pinned or the page cancelled.
function PinPage({ draft, workspaces }: { draft: PinDraft; workspaces: SidebarWorkspaces }) {
    const t = useT();
    const pins = ViewPins.getInstance();
    const ws = useAtomValue(atoms.workspace);
    const [tab] = useWaveObjectValue<Tab>(makeORef("tab", draft.tabId));
    const glyph = useAtomValue(viewGlyphAtom(draft.tabId));
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [draft.tabId]);
    const workspace = workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace");
    const panels = tab?.blockids?.length ?? 0;
    const setDraft = (next: Partial<PinDraft>) =>
        globalStore.set(pins.draftAtom, { ...globalStore.get(pins.draftAtom), ...next });
    const cancel = () => pins.closePinPage();
    const submit = () => fireAndForget(() => pins.finishPinPage());
    const scope = (value: PinScope, titleKey: string, bodyKey: string, extra?: React.ReactNode) => (
        <button
            type="button"
            role="radio"
            aria-checked={draft.scope === value}
            className={cn(
                "mt-sb-scope flex w-full cursor-pointer items-start gap-2.5 rounded-8 border p-2.5 text-left text-secondary transition-colors duration-120 ease-mt",
                draft.scope === value
                    ? "border-accent bg-[color-mix(in_srgb,var(--mt-accent)_12%,rgb(0_0_0/0.18))] text-primary"
                    : "border-white/[0.12] bg-black/[0.18] hover:border-white/25"
            )}
            data-testid={`sidebar-pin-scope-${value}`}
            onClick={() => setDraft({ scope: value })}
        >
            <span className="mt-sb-radio mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full" aria-hidden />
            <span className="text-12 leading-[1.5]">
                <b className="mb-[3px] block text-primary">{t(titleKey, { workspace })}</b>
                {t(bodyKey, { workspace, count: panels })}
                {extra}
            </span>
        </button>
    );
    return (
        <form
            className="flex shrink-0 flex-col gap-3 px-0.5 py-1"
            data-testid="sidebar-pin-page"
            onSubmit={(e) => {
                e.preventDefault();
                submit();
            }}
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    cancel();
                }
            }}
        >
            <div className="flex items-center gap-1.5 border-t border-white/10 pt-1.5">
                <b className="text-13 text-primary">{t("sidebar.pins.page.title")}</b>
                <button
                    type="button"
                    className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
                    aria-label={t("sidebar.pins.page.cancel")}
                    title={t("sidebar.pins.page.cancel")}
                    onClick={cancel}
                >
                    <SidebarGlyph name="x" size={14} />
                </button>
            </div>
            <div className="flex h-[52px] w-24 flex-col items-center justify-center gap-[5px] self-center rounded-6 bg-white/20 px-1 text-11 text-primary shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]">
                <ViewGlyph icons={glyph} />
                <span className="max-w-full truncate">{draft.name || tab?.name}</span>
            </div>
            <label className="flex flex-col gap-[5px] text-12 text-muted">
                {t("sidebar.pins.page.name")}
                <input
                    ref={inputRef}
                    type="text"
                    value={draft.name}
                    data-testid="sidebar-pin-name"
                    className="h-8 rounded-6 border border-white/[0.12] bg-black/25 px-2 text-13 text-primary outline-none focus:border-accent"
                    onChange={(e) => setDraft({ name: e.target.value })}
                />
            </label>
            <div role="radiogroup" aria-label={t("sidebar.pins.page.scope")} className="flex flex-col gap-2">
                {scope("here", "sidebar.pins.page.hereTitle", "sidebar.pins.page.hereBody")}
                {scope(
                    "everywhere",
                    "sidebar.pins.page.everywhereTitle",
                    "sidebar.pins.page.everywhereBody",
                    <span className="mt-sb-mini mt-[7px] flex gap-1" aria-hidden>
                        {workspaces.entries.map((entry) => (
                            <i
                                key={entry.id}
                                className={cn(
                                    "relative inline-block h-4 w-4 rounded-4 opacity-90",
                                    !entry.active && "is-other"
                                )}
                                style={{ background: colourStops(entry.color)[0] ?? "var(--color-secondary)" }}
                            />
                        ))}
                    </span>
                )}
            </div>
            <div className="mt-1 flex flex-col gap-1.5">
                <button
                    type="submit"
                    className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                    data-testid="sidebar-pin-submit"
                >
                    {t("sidebar.pins.page.pin")}
                    <MoltenWave />
                </button>
                <button
                    type="button"
                    className="cursor-pointer rounded-4 border border-white/[0.12] px-3 py-1.5 text-12 text-secondary hover:text-primary"
                    onClick={cancel}
                >
                    {t("sidebar.pins.page.cancel")}
                </button>
            </div>
        </form>
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
                label: t("sidebar.pins.reopenClosed"),
                icon: "rotate-left",
                accelerator: acceleratorById("reopen-closed"),
                click: () => fireAndForget(reopenLastClosed),
            },
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
            <ViewPopoverHost />
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
    const pinDraft = useAtomValue(ViewPins.getInstance().draftAtom);
    useEffect(() => () => clearTimeout(peekTimerRef.current), []);
    useEffect(() => {
        // ⌘Z undoes the sidebar's latest change while its toast shows (FR-SHELL-081); a field keeps its own undo.
        const onKey = (e: KeyboardEvent) => {
            if (undoFromKey(e)) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, []);
    useEffect(() => {
        ViewPins.getInstance().closePinPage();
    }, [ws?.oid]);
    const closedFinished = (ws?.meta as Record<string, any>)?.["molten:closedfinished"];
    useEffect(() => {
        ViewPins.getInstance().showClosedFinished(closedFinished);
    }, [closedFinished, activeTabId, ws?.activetabid]);
    const name = workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace");
    const keepPeek = () => clearTimeout(peekTimerRef.current);
    const endPeek = () => {
        // The open top field keeps the peeked sidebar; closing it ends the peek.
        if (!hidden || TopFieldModel.getInstance().isOpen()) {
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
                <TopField />
                <TopRow instances={split.everywhere ?? {}} activeTabId={activeTabId} />
                <div className="mt-sb-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                    {pinDraft != null ? (
                        <PinPage draft={pinDraft} workspaces={workspaces} />
                    ) : (
                        <>
                            <WorkspaceHeader workspaces={workspaces} />
                            <TileGrid
                                tileIds={split.tiles}
                                activeTabId={activeTabId}
                                label={t("sidebar.tiles.label", { name })}
                            />
                            <TemporaryViews ids={split.temporary} activeTabId={activeTabId} asideRef={asideRef} />
                        </>
                    )}
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
