// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The library (FR-SHELL-088): what is not in the sidebar, over the window, behind the sidebar's bottom-left button.
// Its own navigation on the left, a wide page on the right: every workspace side by side, the panel kinds explained,
// the pages agents hold, the views put away, and settings. Escape and Back close it. Everything the former library
// menu offered keeps a home here (Sessions and Pilotage in Panels, the widgets and apps, the reopen of a closed view,
// tips and settings).

import { atoms, createBlock, getApi, getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { useWaveObjectValue } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { makeConfigFiles } from "@/app/view/waveconfig/waveconfig-model";
import { isWindows } from "@/util/platformutil";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { agentCallName, agentStateMessage } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import {
    BrowserAgentRouteId,
    BrowserAgentStateCommand,
    type AgentTab,
    type PanelAgentState,
} from "../browser/browser-agent";
import { BrowserActiveMetaKey, MoltentermBrowserView, readBrowserState } from "../browser/browser-model";
import { useLocale, useT, useTCount } from "../i18n/i18n";
import { MoltentermNotifications } from "../notifications-store";
import { focusMoltentermView, makeViewInActiveTabAtom } from "../open-view";
import { pickerPanelEntries } from "../palette/palette-sources";
import { ProjectTabMetaKey } from "../project/project-model";
import { type PutAwayView } from "../reopen/reopen-model";
import { listPutAwayViews, reopenPutAwayView } from "../reopen/reopen-store";
import { useListedReviewsAnswer } from "../reviews/reviews-client";
import { MoltentermReviewsView, reviewCounts, reviewsRailLabel } from "../reviews/reviews-model";
import { ReviewsModel } from "../reviews/reviews-store";
import { MoltentermSessionsView } from "../sessions/sessions-model";
import { DurableSessions } from "../sessions/sessions-store";
import { localizeSection, SettingsSectionId, SettingsSections } from "../settings/settings-catalog";
import { openSettings, openSettingsSection } from "../settings/settings-open";
import { PageFill } from "../settings/settings-page";
import { sectionPageWidth, SettingsSectionPage, useSettingsPageData } from "../settings/settings-screen";
import { formatShortcutById } from "../shortcuts/format";
import { workspaceBlocks, type TopRowBlock } from "../sidebar/sidebar-blocks";
import { SidebarGlyph } from "../sidebar/sidebar-icons";
import { readProjectType, splitSidebarTabs } from "../sidebar/sidebar-model";
import { SidebarModel } from "../sidebar/sidebar-store";
import { ViewGlyph, viewGlyphAtom } from "../sidebar/view-glyph";
import { GlobalPinMetaKey, isProjectTab, PinMetaKey } from "../sidebar/view-pins-model";
import { ViewPins } from "../sidebar/view-pins-store";
import { TabActivity, whileShown } from "../tab-activity";
import { panelIcon, tabDisplayName } from "../tab-identity";
import { TabAgentMark, useTabIdentity } from "../tab-identity-ui";
import { showToast } from "../toast-store";
import { colourChoiceCss, colourChoiceForeground, colourStops } from "../workspace-colour";
import { workspaceShownName } from "../workspace-default-name";
import { readWorkspaceProject } from "../workspace-project";
import type { WorkspaceRailEntry } from "../workspace-rail-model";
import { viewNameText } from "../workspace-views/workspace-views-model";
import {
    libraryAddAsk,
    libraryEscapeStep,
    LibrarySection,
    librarySectionAt,
    LibrarySections,
    liveAgents,
    matchesQuery,
    panelAboutKey,
    putAwayAgentNames,
    SentPanel,
    SentRow,
    sentToAiRows,
    suggestClipboardText,
    whenText,
    workspaceAgents,
} from "./library-model";
import "./library.css";
import { MaterialsSection, useMaterialsDrawer, useMaterialsNewCount } from "./materials-section";
import {
    finishSettingsReveal,
    relativeRect,
    revealMode,
    revealTargets,
    runSettingsReveal,
    SettingsRevealKey,
    type RevealRect,
} from "./settings-reveal";

const PinnedTabMetaKeys = [ProjectTabMetaKey, PinMetaKey];
const SentPollMs = 5000;
const SentCallTimeoutMs = 3000;

function close() {
    SidebarModel.getInstance().closeLibrary();
}

function workspaceNameOf(entries: WorkspaceRailEntry[], id: string): string {
    return entries.find((e) => e.id === id)?.name ?? "";
}

// Goes to a view, in its workspace: the workspace shows it once switched to.
async function goToView(workspaceId: string, tabId: string): Promise<void> {
    close();
    if (workspaceId === globalStore.get(atoms.workspaceId)) {
        getApi().setActiveTab(tabId);
        return;
    }
    await WorkspaceService.SetActiveTab(workspaceId, tabId);
    getApi().switchWorkspace(workspaceId);
}

// Goes to a panel. In another workspace its view becomes that workspace's active one first: the switch shows the
// workspace's active view, which a notification's own way there leaves as it was.
async function goToBlock(workspaceId: string, tabId: string, blockId: string): Promise<void> {
    if (workspaceId && tabId && workspaceId !== globalStore.get(atoms.workspaceId)) {
        await WorkspaceService.SetActiveTab(workspaceId, tabId);
    }
    await MoltentermNotifications.getInstance().goTo({ workspaceid: workspaceId, tabid: tabId, blockid: blockId });
}

function goToWorkspace(workspaceId: string) {
    close();
    if (workspaceId !== globalStore.get(atoms.workspaceId)) {
        getApi().switchWorkspace(workspaceId);
    }
}

// ---------- Workspaces ----------

// The workspace's views, and its blocks as its sidebar shows them (sidebar-blocks.ts, #1307).
function useWorkspaceSplit(ws: Workspace) {
    const splitAtom = useMemo(
        () =>
            atom((get) => {
                const pins = get(ViewPins.getInstance().globalPinsAtom);
                const split = splitSidebarTabs(
                    ws ?? {},
                    (id) => get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", id))),
                    PinnedTabMetaKeys,
                    new Set(pins.map((p) => p.id)),
                    GlobalPinMetaKey
                );
                return { split, blocks: workspaceBlocks(pins, split) };
            }),
        [ws]
    );
    return useAtomValue(splitAtom);
}

// A top-row block, as in the sidebar: the pin's glyph, its name on hover; the agent in this workspace's instance as a
// corner mark. A block the workspace never opened goes to the workspace, or opens there when it is the current one.
function LibraryTopBlock({ workspaceId, block, active }: { workspaceId: string; block: TopRowBlock; active: boolean }) {
    const go = () => {
        if (block.tabId) {
            return goToView(workspaceId, block.tabId);
        }
        if (workspaceId !== globalStore.get(atoms.workspaceId)) {
            goToWorkspace(workspaceId);
            return;
        }
        close();
        return ViewPins.getInstance().openGlobalPin(block.pin.id, "");
    };
    return (
        <button
            type="button"
            className={cn("mt-lib-tile mt-lib-top", active && "is-on")}
            title={block.name}
            aria-label={block.name}
            data-testid="library-top-block"
            data-pin-id={block.pin.id}
            onClick={(e) => {
                e.stopPropagation();
                fireAndForget(go);
            }}
        >
            <ViewGlyph icons={block.glyph} small={block.glyph.length > 1} className="max-w-full overflow-hidden" />
            {block.tabId ? <LibraryAgentMark tabId={block.tabId} /> : null}
        </button>
    );
}

function LibraryAgentMark({ tabId }: { tabId: string }) {
    const identity = useTabIdentity(tabId, "");
    return (
        <span className="absolute top-1 right-1 flex">
            <TabAgentMark info={identity.agent} />
        </span>
    );
}

function LibraryTile({ workspaceId, tabId, active }: { workspaceId: string; tabId: string; active: boolean }) {
    const [tab] = useWaveObjectValue<Tab>(WOS.makeORef("tab", tabId));
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    const glyph = useAtomValue(viewGlyphAtom(tabId));
    return (
        <button
            type="button"
            className={cn("mt-lib-tile", active && "is-on")}
            title={identity.name}
            data-testid="library-tile"
            onClick={(e) => {
                e.stopPropagation();
                fireAndForget(() => goToView(workspaceId, tabId));
            }}
        >
            <ViewGlyph icons={glyph} className="max-w-full overflow-hidden" />
            <span className="max-w-full truncate">{identity.name}</span>
            <span className="absolute top-1 right-1 flex">
                <TabAgentMark info={identity.agent} />
            </span>
        </button>
    );
}

function LibraryViewRow({ workspaceId, tabId, active }: { workspaceId: string; tabId: string; active: boolean }) {
    const [tab] = useWaveObjectValue<Tab>(WOS.makeORef("tab", tabId));
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    const glyph = useAtomValue(viewGlyphAtom(tabId));
    return (
        <button
            type="button"
            className={cn("mt-lib-mrow", active && "is-on")}
            title={identity.name}
            data-testid="library-view"
            onClick={(e) => {
                e.stopPropagation();
                fireAndForget(() => goToView(workspaceId, tabId));
            }}
        >
            <ViewGlyph icons={glyph} small className="min-w-4 justify-center" />
            <span className="t">{identity.name}</span>
            <TabAgentMark info={identity.agent} />
        </button>
    );
}

function WorkspaceColumn({ entry }: { entry: WorkspaceRailEntry }) {
    const t = useT();
    const tc = useTCount();
    const [ws] = useWaveObjectValue<Workspace>(WOS.makeORef("workspace", entry.id));
    const { split, blocks } = useWorkspaceSplit(ws);
    const data = useAtomValue(AgentStates.getInstance().dataAtom);
    const agents = useMemo(() => workspaceAgents(data, entry.id), [data, entry.id]);
    const live = liveAgents(agents);
    const choice = ws?.color ?? entry.color;
    const stops = colourStops(choice);
    const paint = stops.length > 0 ? colourChoiceCss(choice) : "var(--color-secondary)";
    const accent = stops[0] ?? "var(--color-secondary)";
    const name = workspaceShownName(ws?.name, t) || entry.name;
    const type = readProjectType(ws);
    const folder =
        (readWorkspaceProject(ws).dir ?? "")
            .replace(/[/\\]+$/, "")
            .split(/[/\\]/)
            .pop() ?? "";
    const sub = [type, folder].filter(Boolean).join(" · ");
    const activeTabId = ws?.activetabid;
    return (
        <div
            role="button"
            tabIndex={0}
            className={cn("mt-lib-wscol", entry.active && "is-cur")}
            style={{ ["--mt-lib-c" as string]: accent } as React.CSSProperties}
            title={t("library.workspaces.goTo", { name })}
            data-testid="library-workspace"
            data-workspace-id={entry.id}
            onClick={() => goToWorkspace(entry.id)}
            onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    goToWorkspace(entry.id);
                }
            }}
        >
            <div className="flex items-center gap-2">
                <span
                    className="mt-lib-lg"
                    style={{ background: paint, color: stops.length > 0 ? colourChoiceForeground(choice) : "black" }}
                >
                    {(Array.from(name)[0] ?? "").toUpperCase()}
                </span>
                <div className="min-w-0">
                    <div className="truncate font-semibold text-primary">{name}</div>
                    {sub ? <div className="truncate text-11 text-muted">{sub}</div> : null}
                </div>
            </div>
            {blocks.top.length > 0 ? (
                <div className="grid grid-cols-4 gap-1.5" data-testid="library-top-row">
                    {blocks.top.map((block) => (
                        <LibraryTopBlock
                            key={block.pin.id}
                            workspaceId={entry.id}
                            block={block}
                            active={!!block.tabId && block.tabId === activeTabId}
                        />
                    ))}
                </div>
            ) : null}
            {blocks.tiles.length > 0 ? (
                <div className="grid grid-cols-2 gap-1.5">
                    {blocks.tiles.map((id) => (
                        <LibraryTile key={id} workspaceId={entry.id} tabId={id} active={id === activeTabId} />
                    ))}
                </div>
            ) : null}
            {agents.length > 0 ? (
                <>
                    <div className="mt-lib-sect">
                        <span>{t("library.workspaces.agents")}</span>
                        <span>{live > 0 ? tc("library.workspaces.live", live) : t("library.workspaces.resting")}</span>
                    </div>
                    {agents.map((info) => (
                        <button
                            key={info.blockid}
                            type="button"
                            className="mt-lib-mrow"
                            title={agentStateMessage(info) || agentCallName(info)}
                            data-testid="library-agent"
                            onClick={(e) => {
                                e.stopPropagation();
                                close();
                                fireAndForget(() => goToBlock(info.workspaceid, info.tabid, info.blockid));
                            }}
                        >
                            <span className={cn("mt-lib-av", `is-${info.state ?? "idle"}`)}>
                                {(Array.from(agentCallName(info))[0] ?? "").toUpperCase()}
                            </span>
                            <span className="t">
                                {agentCallName(info)}{" "}
                                <span className="text-muted">{agentStateMessage(info) || info.agentname || ""}</span>
                            </span>
                        </button>
                    ))}
                </>
            ) : null}
            {split.temporary.length > 0 ? (
                <>
                    <div className="mt-lib-sect">
                        <span>{t("library.workspaces.openViews")}</span>
                        <span>{split.temporary.length}</span>
                    </div>
                    {split.temporary.map((id) => (
                        <LibraryViewRow key={id} workspaceId={entry.id} tabId={id} active={id === activeTabId} />
                    ))}
                </>
            ) : null}
        </div>
    );
}

function WorkspacesSection({ entries }: { entries: WorkspaceRailEntry[] }) {
    return (
        <div className="mt-lib-wscols" data-testid="library-workspaces">
            {entries.map((entry) => (
                <WorkspaceColumn key={entry.id} entry={entry} />
            ))}
        </div>
    );
}

// ---------- Panels ----------

function PanelsSection({ onApps }: { onApps: () => void }) {
    const t = useT();
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const workspaceId = useAtomValue(atoms.workspaceId);
    const workspace = useAtomValue(atoms.workspace);
    const tabId = useAtomValue(atoms.staticTabId);
    const [tab] = useWaveObjectValue<Tab>(WOS.makeORef("tab", tabId));
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    const sessions = useAtomValue(DurableSessions.getInstance().badgeAtom);
    const dir = readWorkspaceProject(workspace).dir;
    const answer = useListedReviewsAnswer(dir);
    const readied = useAtomValue(ReviewsModel.getInstance().readiedAtom);
    const reviewsShown = useAtomValue(makeViewInActiveTabAtom(MoltentermReviewsView));
    const sessionsShown = useAtomValue(makeViewInActiveTabAtom(MoltentermSessionsView));
    const showApps = getApi().getIsDev() || (fullConfig?.settings?.["feature:waveappbuilder"] ?? false);
    const entries = useMemo(
        () => pickerPanelEntries(fullConfig?.widgets, workspaceId, null, !!dir),
        [fullConfig?.widgets, workspaceId, dir]
    );
    const viewState = useAtomValue(ViewPins.getInstance().stateAtom(tabId));
    const [asking, setAsking] = useState<string>(null);
    const viewName = identity.name || t("library.panels.thisView");
    const counts = reviewCounts(answer, readied);
    const hasReviews = counts.toreview + counts.mergeable + counts.drafts > 0;
    // A pinned view changes only when the developer says so (FR-SHELL-094): Add to names it and asks first.
    const askKey = libraryAddAsk(viewState, isProjectTab(tab));
    const inNewView = (blockdef: BlockDef) => {
        close();
        getApi().createTab(blockdef);
    };
    const add = (blockdef: BlockDef) => {
        close();
        const view = blockdef?.meta?.view;
        // Added here, in the view the developer named: never through openMoltentermView, which keeps pinned views
        // as they are.
        fireAndForget(async () => {
            if (
                (view === MoltentermReviewsView || view === MoltentermSessionsView) &&
                (await focusMoltentermView(view))
            ) {
                return;
            }
            await createBlock(blockdef);
        });
    };
    return (
        <div className="flex flex-col gap-3">
            <div className="mt-lib-pcards" data-testid="library-panels">
                {entries.map((entry) => {
                    if (entry.run.kind !== "widget") {
                        return null;
                    }
                    const blockdef = entry.run.blockdef;
                    const view = blockdef?.meta?.view ?? "";
                    const aboutKey = panelAboutKey(view);
                    const about = aboutKey ? t(aboutKey) : entry.detail;
                    const status =
                        view === MoltentermReviewsView && hasReviews
                            ? reviewsRailLabel(counts)
                            : view === MoltentermSessionsView && sessions.count > 0
                              ? sessions.label
                              : null;
                    const shown =
                        (view === MoltentermReviewsView && reviewsShown != null) ||
                        (view === MoltentermSessionsView && sessionsShown != null);
                    return (
                        <div key={entry.id} className="mt-lib-pcard" data-testid="library-panel" data-view={view}>
                            <div className="flex items-center gap-2 font-semibold text-primary">
                                <i className="mt-lib-pic" aria-hidden>
                                    <i className={makeIconClass(entry.icon, true, { defaultIcon: "square" })} />
                                </i>
                                <span className="truncate">{entry.label}</span>
                            </div>
                            {about ? <p>{about}</p> : <p />}
                            {status && status !== entry.label ? (
                                <div className="text-11 text-secondary">{status}</div>
                            ) : null}
                            {asking === entry.id && !shown ? (
                                <div className="mt-lib-ask" role="group" data-testid="library-panel-ask">
                                    <div className="text-11 text-secondary">{t(askKey, { view: viewName })}</div>
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        <button
                                            type="button"
                                            className="mt-lib-btn"
                                            data-testid="library-panel-ask-add"
                                            onClick={() => add(blockdef)}
                                        >
                                            {t("library.panels.addTo", { view: viewName })}
                                        </button>
                                        <button
                                            type="button"
                                            className="mt-lib-btn"
                                            data-testid="library-panel-ask-newview"
                                            onClick={() => inNewView(blockdef)}
                                        >
                                            {t("library.panels.inNewView")}
                                        </button>
                                        <button type="button" className="mt-lib-link" onClick={() => setAsking(null)}>
                                            {t("common.cancel")}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    className="mt-lib-btn"
                                    data-testid="library-panel-add"
                                    onClick={() => (askKey && !shown ? setAsking(entry.id) : add(blockdef))}
                                >
                                    {shown ? (
                                        t("library.panels.show")
                                    ) : (
                                        <>
                                            <SidebarGlyph name="plus" size={12} />
                                            {t("library.panels.addTo", { view: viewName })}
                                        </>
                                    )}
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    className="mt-lib-link"
                    data-testid="library-edit-widgets"
                    onClick={() => {
                        close();
                        fireAndForget(() => openSettings("widgets.json"));
                    }}
                >
                    <i className={makeIconClass("pen", true)} aria-hidden />
                    {t("library.panels.editList")}
                </button>
                {showApps ? (
                    <button type="button" className="mt-lib-link" data-testid="library-apps" onClick={onApps}>
                        <i className={makeIconClass("cube", true)} aria-hidden />
                        {t("rail.tools.apps")}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

// ---------- Sent to AI ----------

async function readSentPanels(entries: WorkspaceRailEntry[]): Promise<SentPanel[]> {
    const rtn: SentPanel[] = [];
    for (const entry of entries) {
        const ws = await WOS.reloadWaveObject<Workspace>(WOS.makeORef("workspace", entry.id));
        for (const tabId of ws?.tabids ?? []) {
            const tab = await WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", tabId));
            for (const blockId of tab?.blockids ?? []) {
                const block = await WOS.reloadWaveObject<Block>(WOS.makeORef("block", blockId));
                if (block?.meta?.view !== MoltentermBrowserView) {
                    continue;
                }
                let state: PanelAgentState = null;
                try {
                    state = await TabRpcClient.wshRpcCall(
                        BrowserAgentStateCommand,
                        { blockid: blockId },
                        { route: BrowserAgentRouteId, timeout: SentCallTimeoutMs }
                    );
                } catch {
                    continue;
                }
                const agentTabs: AgentTab[] = state?.tabs ?? [];
                if (agentTabs.length === 0) {
                    continue;
                }
                rtn.push({
                    panelBlockId: blockId,
                    tabId,
                    workspaceId: entry.id,
                    agentTabs,
                    browserTabs: readBrowserState(block.meta as Record<string, any>, "").tabs,
                });
            }
        }
    }
    return rtn;
}

function SentToAiSection({ entries, query }: { entries: WorkspaceRailEntry[]; query: string }) {
    const t = useT();
    const locale = useLocale();
    const [rows, setRows] = useState<SentRow[]>(null);
    const entriesKey = entries.map((e) => e.id).join(" ");
    const entriesRef = useRef(entries);
    entriesRef.current = entries;
    useEffect(() => {
        let cancelled = false;
        const load = () =>
            fireAndForget(async () => {
                try {
                    const next = sentToAiRows(await readSentPanels(entriesRef.current));
                    if (!cancelled) {
                        setRows(next);
                    }
                } catch (e) {
                    console.log("library: sent to AI", e);
                }
            });
        load();
        const stop = TabActivity.getInstance().every(whileShown(SentPollMs), load, "library-sent-to-ai");
        return () => {
            cancelled = true;
            stop();
        };
    }, [entriesKey]);
    if (rows == null) {
        return null;
    }
    const shown = rows.filter((r) =>
        matchesQuery([r.title, r.url, r.agentName, workspaceNameOf(entries, r.workspaceId)], query)
    );
    if (shown.length === 0) {
        return (
            <div className="mt-lib-empty" data-testid="library-ai-empty">
                <b>{t(rows.length === 0 ? "library.ai.emptyTitle" : "library.nothingFound")}</b>
                {rows.length === 0 ? <span>{t("library.ai.empty")}</span> : null}
            </div>
        );
    }
    const open = (row: SentRow) => {
        close();
        fireAndForget(async () => {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", row.panelBlockId),
                meta: { [BrowserActiveMetaKey]: row.browserTabId } as MetaType,
            });
            await goToBlock(row.workspaceId, row.tabId, row.panelBlockId);
        });
    };
    return (
        <div className="flex flex-col gap-0.5" data-testid="library-ai">
            <div className="mt-lib-day">{t("library.ai.now")}</div>
            {shown.map((row) => {
                const when = whenText(row.since, Date.now(), locale);
                const parts = [
                    row.agentName,
                    workspaceNameOf(entries, row.workspaceId),
                    when ? t("library.ai.since", { when }) : "",
                ].filter(Boolean);
                return (
                    <button
                        key={row.key}
                        type="button"
                        className="mt-lib-airow"
                        title={row.url}
                        data-testid="library-ai-row"
                        onClick={() => open(row)}
                    >
                        <SidebarGlyph name="globe" />
                        <span className="t">
                            <b>{row.title}</b>
                            <span>{parts.join(" · ")}</span>
                        </span>
                        <span className={cn("mt-lib-state", row.shared && "is-live")}>
                            {t(row.shared ? "library.ai.shared" : "library.ai.opened")}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

// ---------- Put-away views ----------

function PutAwaySection({ entries, query }: { entries: WorkspaceRailEntry[]; query: string }) {
    const t = useT();
    const tc = useTCount();
    const locale = useLocale();
    const [views, setViews] = useState<PutAwayView[]>(null);
    const [busy, setBusy] = useState<string>(null);
    const home = getApi().getHomeDir();
    const load = () =>
        fireAndForget(async () => {
            try {
                setViews(await listPutAwayViews());
            } catch (e) {
                console.log("library: put-away views", e);
                setViews([]);
            }
        });
    useEffect(load, []);
    if (views == null) {
        return null;
    }
    const named = views.map((v) => ({
        view: v,
        name: tabDisplayName(viewNameText(v.name, t), v.panels?.[0], home) || t("library.putaway.unnamed"),
        workspace: workspaceNameOf(entries, v.workspaceid),
        agents: putAwayAgentNames(v),
    }));
    const shown = named.filter((n) => matchesQuery([n.name, n.workspace, ...n.agents], query));
    const reopen = (view: PutAwayView) => {
        setBusy(view.id);
        fireAndForget(async () => {
            try {
                const res = await reopenPutAwayView(view);
                if (!res?.reopened) {
                    showToast({ kind: "info", title: t("library.putaway.gone") });
                    load();
                    return;
                }
                close();
            } catch (e) {
                showToast({ kind: "error", title: t("reopen.failed"), message: String(e?.message ?? e) });
                load();
            } finally {
                setBusy(null);
            }
        });
    };
    if (shown.length === 0) {
        return (
            <div className="mt-lib-empty" data-testid="library-putaway-empty">
                <b>{t(views.length === 0 ? "library.putaway.emptyTitle" : "library.nothingFound")}</b>
                {views.length === 0 ? <span>{t("library.putaway.empty")}</span> : null}
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-1.5" data-testid="library-putaway">
            {shown.map(({ view, name, workspace, agents }) => {
                const facts = [
                    workspace,
                    whenText(view.at, Date.now(), locale),
                    tc("library.putaway.panels", view.panels?.length ?? 0),
                ].filter(Boolean);
                return (
                    <div key={view.id} className="mt-lib-item" data-testid="library-putaway-row">
                        <i
                            className={cn(
                                makeIconClass(panelIcon(view.panels?.[0], agents.length > 0), true),
                                "w-4 text-center text-secondary"
                            )}
                            aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-primary">{name}</div>
                            <div className="truncate text-11 text-muted">{facts.join(" · ")}</div>
                        </div>
                        {agents.length > 0 ? (
                            <span className="mt-lib-state" title={t("library.putaway.withAgentTitle")}>
                                {t("library.putaway.withAgent", { agents: agents.join(", ") })}
                            </span>
                        ) : null}
                        <button
                            type="button"
                            className="mt-lib-btn"
                            disabled={busy != null}
                            data-testid="library-reopen"
                            onClick={() => reopen(view)}
                        >
                            {t("library.putaway.reopen")}
                        </button>
                    </div>
                );
            })}
        </div>
    );
}

// ---------- Settings ----------

// Leaves the library for a Preferences view: only on the developer's explicit ask (#1406).
function openInView(run: () => Promise<unknown>) {
    close();
    fireAndForget(run);
}

function isFieldInSettingsBlock(target: EventTarget): boolean {
    const el = target as HTMLElement;
    return el?.closest?.(".mt-lib-setpage") != null && el.matches?.("input, textarea, select, [contenteditable]");
}

const LibraryRowIdPrefix = "molten-setting-library-";

function libraryRowId(key: string): string {
    return `${LibraryRowIdPrefix}${key.replace(/[^a-z0-9]/gi, "-")}`;
}

// A settings block open in the library's page, with the rows of Preferences (FR-SHELL-088, #1406). What needs a
// Preferences view (a JSON file in the editor, Secrets) opens one, as "Open in a view" does.
function LibrarySettingsBlock({ block, onBack }: { block: SettingsSectionId; onBack: () => void }) {
    const t = useT();
    const data = useSettingsPageData();
    const files = useMemo(
        () => makeConfigFiles(isWindows()).map((f) => ({ path: f.path, name: f.name, description: f.description })),
        []
    );
    const blockTitle = data.sections.find((s) => s.id === block)?.title ?? block;
    return (
        <div
            className="mt-lib-setpage @container/page min-w-0"
            data-testid="library-settings-block"
            data-section={block}
            onKeyDown={(e) => {
                if (e.key !== "Escape" || e.defaultPrevented) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                onBack();
            }}
        >
            <button
                type="button"
                className="mt-lib-setback"
                data-testid="library-settings-back"
                title={t("library.settings.backTitle")}
                onClick={onBack}
            >
                <SidebarGlyph name="back" size={14} />
                {t("library.settings.back")}
            </button>
            <PageFill width={sectionPageWidth(data, block)} className="pt-0 pb-6">
                <SettingsSectionPage
                    section={block}
                    data={data}
                    rowId={libraryRowId}
                    files={files}
                    onOpenFile={(path) => openInView(() => openSettings(path))}
                    actions={
                        <button
                            type="button"
                            className="molten-btn-secondary inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12"
                            data-testid="library-settings-openview"
                            title={t("library.settings.openInViewTitle", { name: blockTitle })}
                            onClick={() => openInView(() => openSettingsSection(block))}
                        >
                            <i className={makeIconClass("arrow-up-right-from-square", true)} aria-hidden />
                            {t("library.settings.openInView")}
                        </button>
                    }
                />
            </PageFill>
        </div>
    );
}

// The settings blocks, and the one the developer opened, in one stage (#1406). The blocks stay mounted in Preferences'
// order while one is open; the open block is revealed by settings-reveal.ts (#1407).
function SettingsSection({
    block,
    onOpen,
    onBack,
}: {
    block: SettingsSectionId;
    onOpen: (block: SettingsSectionId) => void;
    onBack: () => void;
}) {
    const t = useT();
    const hasConfigErrors = useAtomValue(atoms.hasConfigErrors);
    const reducedMotion = useAtomValue(atoms.prefersReducedMotionAtom);
    const revealSetting = useAtomValue(getSettingsKeyAtom(SettingsRevealKey));
    const stageRef = useRef<HTMLDivElement>(null);
    const layerRef = useRef<HTMLDivElement>(null);
    const sourceRef = useRef<RevealRect>(null);
    // The molten reveal of the block just opened (#1407), before its first frame; going back, switching section or
    // closing the library ends it.
    useLayoutEffect(() => {
        const stage = stageRef.current;
        const page = stage?.querySelector(".mt-lib-setpage");
        if (block == null || page == null || layerRef.current == null) {
            return;
        }
        const handle = runSettingsReveal({
            stage,
            overlay: layerRef.current,
            cards: revealTargets(page),
            chrome: [page.querySelector(".mt-lib-setback"), page.children[1]?.firstElementChild].filter(
                (el) => el != null
            ),
            source: sourceRef.current,
            mode: revealMode(reducedMotion, revealSetting !== false),
        });
        sourceRef.current = null;
        return () => {
            handle.finish();
        };
    }, [block]);
    const openFromTile = (id: SettingsSectionId, tile: HTMLElement) => {
        const stage = stageRef.current;
        sourceRef.current =
            stage != null ? relativeRect(tile.getBoundingClientRect(), stage.getBoundingClientRect()) : null;
        onOpen(id);
    };
    return (
        <div
            ref={stageRef}
            className="mt-lib-setstage flex flex-col gap-3"
            data-testid="library-settings-stage"
            data-state={block != null ? "open" : "tiles"}
            data-open={block ?? undefined}
        >
            {hasConfigErrors && block == null ? (
                <button
                    type="button"
                    className="mt-lib-set is-error"
                    data-testid="library-settings-errors"
                    onClick={() => openInView(() => openSettings())}
                >
                    <i className={makeIconClass("triangle-exclamation", true)} aria-hidden />
                    <span>{t("rail.tools.settingsErrors")}</span>
                </button>
            ) : null}
            <div
                className="mt-lib-setgrid"
                data-testid="library-settings"
                aria-hidden={block != null ? true : undefined}
            >
                {SettingsSections.map((s) => {
                    const section = localizeSection(s, t);
                    return (
                        <button
                            key={s.id}
                            type="button"
                            className="mt-lib-set"
                            data-testid="library-settings-section"
                            data-section={s.id}
                            tabIndex={block != null ? -1 : undefined}
                            onClick={(e) => openFromTile(s.id, e.currentTarget)}
                        >
                            <i className={makeIconClass(s.icon, true)} aria-hidden />
                            <span>
                                {section.title}
                                <small>{section.description}</small>
                            </span>
                        </button>
                    );
                })}
            </div>
            {block != null ? <LibrarySettingsBlock block={block} onBack={onBack} /> : null}
            <div ref={layerRef} className="mt-reveal-layer" data-testid="library-settings-reveal" aria-hidden />
        </div>
    );
}

// ---------- Suggest MoltenTerm ----------

function SuggestPopover({ onClose }: { onClose: () => void }) {
    const t = useT();
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const away = (e: MouseEvent) => {
            if (ref.current != null && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener("mousedown", away, true);
        return () => document.removeEventListener("mousedown", away, true);
    }, [onClose]);
    return (
        <div
            ref={ref}
            className="mt-lib-pop"
            role="dialog"
            aria-label={t("library.suggest.title")}
            data-testid="library-suggest"
        >
            <b>{t("library.suggest.title")}</b>
            <p>{t("library.suggest.text")}</p>
            <button
                type="button"
                className="mt-lib-btn"
                data-testid="library-suggest-copy"
                onClick={() => {
                    onClose();
                    fireAndForget(async () => {
                        try {
                            await navigator.clipboard.writeText(suggestClipboardText());
                            showToast({ kind: "success", title: t("library.suggest.copied") });
                        } catch (e) {
                            showToast({ kind: "error", title: t("library.suggest.failed"), message: String(e) });
                        }
                    });
                }}
            >
                <SidebarGlyph name="link" size={13} />
                {t("library.suggest.copy")}
            </button>
        </div>
    );
}

// ---------- The library ----------

export function Library({
    section,
    entries,
    onApps,
}: {
    section: LibrarySection;
    entries: WorkspaceRailEntry[];
    onApps: () => void;
}) {
    const t = useT();
    const tc = useTCount();
    const [query, setQuery] = useState("");
    const [suggest, setSuggest] = useState(false);
    const [settingsBlock, setSettingsBlock] = useState<SettingsSectionId>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const info = LibrarySections.find((s) => s.id === section) ?? LibrarySections[0];
    const reopenKeys = formatShortcutById("reopen-closed");
    const workspaceId = useAtomValue(atoms.workspaceId);
    const materials = useMaterialsDrawer(workspaceId);
    const newMaterials = useMaterialsNewCount(materials.view, section === "materials");
    useEffect(() => {
        setQuery("");
        setSettingsBlock(null);
    }, [section]);
    // Back to the blocks, the focus on the one just closed.
    const backToBlocks = () => {
        const shown = settingsBlock;
        setSettingsBlock(null);
        requestAnimationFrame(() =>
            rootRef.current?.querySelector<HTMLElement>(`.mt-lib-set[data-section="${shown}"]`)?.focus()
        );
    };
    const openSettingsBlock = (block: SettingsSectionId) => {
        setSettingsBlock(block);
        requestAnimationFrame(() =>
            rootRef.current?.querySelector<HTMLElement>('[data-testid="library-settings-back"]')?.focus()
        );
    };
    useEffect(() => {
        const previous = document.activeElement as HTMLElement;
        rootRef.current?.querySelector<HTMLElement>(".mt-lib-ni.is-on")?.focus();
        return () => previous?.focus?.();
    }, []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") {
                return;
            }
            // A question or a field of a row (Materials' rename, where to open, delete) cancels itself first.
            if ((e.target as HTMLElement)?.closest?.("[data-lib-escape]") != null) {
                return;
            }
            // An Escape during the reveal of a block only ends the reveal (#1407).
            if (finishSettingsReveal()) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const step = libraryEscapeStep(suggest, settingsBlock != null);
            // A field of the open block takes Escape first (a text field puts its saved value back); the block's own
            // handler goes back to the blocks when the field leaves it.
            if (step === "settingsBlock" && isFieldInSettingsBlock(e.target)) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            if (step === "suggest") {
                setSuggest(false);
                return;
            }
            if (step === "settingsBlock") {
                backToBlocks();
                return;
            }
            close();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [suggest, settingsBlock]);
    // Each view of the window draws its own library: one left for another view (a workspace dot, a reopened view)
    // must not wait open for the developer's return.
    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState === "hidden") {
                close();
            }
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, []);
    const sub =
        section === "putaway" && reopenKeys
            ? `${t(`library.sections.${info.key}.sub`)} ${t("library.putaway.lastKeys", { keys: reopenKeys })}`
            : t(`library.sections.${info.key}.sub`);
    return (
        <div
            ref={rootRef}
            className="mt-lib"
            role="dialog"
            aria-label={t("library.label")}
            data-testid="library"
            data-section={section}
        >
            <nav className="mt-lib-nav" aria-label={t("library.navLabel")}>
                <div className="mt-lib-navtop" />
                <div
                    className="mt-lib-items"
                    role="tablist"
                    aria-orientation="vertical"
                    onKeyDown={(e) => {
                        const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
                        if (step === 0) {
                            return;
                        }
                        e.preventDefault();
                        const next = librarySectionAt(section, step);
                        SidebarModel.getInstance().openLibrary(next);
                        requestAnimationFrame(() =>
                            rootRef.current?.querySelector<HTMLElement>(`[data-lib="${next}"]`)?.focus()
                        );
                    }}
                >
                    {LibrarySections.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            role="tab"
                            aria-selected={s.id === section}
                            tabIndex={s.id === section ? 0 : -1}
                            className={cn("mt-lib-ni", s.id === section && "is-on")}
                            data-lib={s.id}
                            data-testid="library-nav"
                            onClick={() => SidebarModel.getInstance().openLibrary(s.id)}
                        >
                            <SidebarGlyph name={s.glyph} size={22} />
                            <span>{t(`library.sections.${s.key}.label`)}</span>
                            {s.id === "materials" && newMaterials > 0 ? (
                                <span
                                    className="mt-lib-cnt"
                                    title={tc("library.materials.newCount", newMaterials)}
                                    aria-label={tc("library.materials.newCount", newMaterials)}
                                    data-testid="library-materials-new"
                                >
                                    {newMaterials}
                                </span>
                            ) : null}
                        </button>
                    ))}
                </div>
                <div className="mt-lib-bot">
                    <button
                        type="button"
                        className="mt-lib-icon"
                        title={t("library.backTitle")}
                        aria-label={t("library.back")}
                        data-testid="library-back"
                        onClick={close}
                    >
                        <SidebarGlyph name="back" />
                    </button>
                    <button
                        type="button"
                        className="mt-lib-icon"
                        title={t("library.suggest.title")}
                        aria-label={t("library.suggest.title")}
                        aria-expanded={suggest}
                        data-testid="library-suggest-button"
                        onClick={() => setSuggest((v) => !v)}
                    >
                        <SidebarGlyph name="share" />
                    </button>
                    {suggest ? <SuggestPopover onClose={() => setSuggest(false)} /> : null}
                </div>
            </nav>
            <section className="mt-lib-cont" role="tabpanel">
                <div className="mt-lib-head">
                    <div className="min-w-0">
                        <h3>{t(`library.sections.${info.key}.title`)}</h3>
                        <p>{sub}</p>
                    </div>
                    {info.search ? (
                        <input
                            className="mt-lib-search"
                            type="search"
                            value={query}
                            placeholder={t("library.search")}
                            aria-label={t("library.search")}
                            data-testid="library-search"
                            onChange={(e) => setQuery(e.target.value)}
                        />
                    ) : null}
                </div>
                <div className="mt-lib-body">
                    {section === "workspaces" ? <WorkspacesSection entries={entries} /> : null}
                    {section === "panels" ? <PanelsSection onApps={onApps} /> : null}
                    {section === "ai" ? <SentToAiSection entries={entries} query={query} /> : null}
                    {section === "materials" ? (
                        <MaterialsSection view={materials.view} failed={materials.failed} query={query} />
                    ) : null}
                    {section === "putaway" ? <PutAwaySection entries={entries} query={query} /> : null}
                    {section === "settings" ? (
                        <SettingsSection block={settingsBlock} onOpen={openSettingsBlock} onBack={backToBlocks} />
                    ) : null}
                </div>
            </section>
        </div>
    );
}
