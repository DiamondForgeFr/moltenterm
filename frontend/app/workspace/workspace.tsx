// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AIPanel } from "@/app/aipanel/aipanel";
import { ErrorBoundary } from "@/app/element/errorboundary";
import { CenteredDiv } from "@/app/element/quickelems";
import { ModalsRenderer } from "@/app/modals/modalsrenderer";
import { TabBar } from "@/app/tab/tabbar";
import { TabContent } from "@/app/tab/tabcontent";
import { VTabBar } from "@/app/tab/vtabbar";
import { Widgets } from "@/app/workspace/widgets";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { atoms, getApi, getSettingsKeyAtom } from "@/store/global";
import { MoltentermNoAI } from "@/util/moltenterm-noai"; // MOLTENTERM-PATCH (#25)
import { isMacOS } from "@/util/platformutil";
import { useAtomValue } from "jotai";
import { memo, useEffect, useRef } from "react";
import {
    ImperativePanelGroupHandle,
    ImperativePanelHandle,
    Panel,
    PanelGroup,
    PanelResizeHandle,
} from "react-resizable-panels";
// MOLTENTERM-PATCH (#44, #55, #110)
import { MoltentermStatusBar, MoltentermToolRail, MoltentermWorkspaceRail } from "../../moltenterm-shell/shell-flags";
import { SidebarModel } from "../../moltenterm-shell/sidebar/sidebar-store"; // MOLTENTERM-PATCH (#1183)
import { SidebarContentStrip, WorkspaceSidebar } from "../../moltenterm-shell/sidebar/workspace-sidebar"; // MOLTENTERM-PATCH (#1183)
import { frameSizes } from "../../moltenterm-shell/sidebar/window-corner-model"; // MOLTENTERM-PATCH (#1216)
import { StatusBar } from "../../moltenterm-shell/status-bar"; // MOLTENTERM-PATCH (#55)
import { ViewPendingOverlay } from "../../moltenterm-shell/view-pending"; // MOLTENTERM-PATCH (#450)
import { WorkspaceRail } from "../../moltenterm-shell/workspace-rail"; // MOLTENTERM-PATCH (#44)

const MacOSTabBarSpacer = memo(() => {
    return (
        <div
            className="w-full shrink-0"
            style={
                {
                    height: "calc(8px * var(--zoomfactor-inv))",
                    WebkitAppRegion: "drag",
                    backdropFilter: "blur(20px)",
                    background: "rgba(0, 0, 0, 0.35)",
                } as React.CSSProperties
            }
        />
    );
});
MacOSTabBarSpacer.displayName = "MacOSTabBarSpacer";

const WorkspaceElem = memo(() => {
    const workspaceLayoutModel = WorkspaceLayoutModel.getInstance();
    const tabId = useAtomValue(atoms.staticTabId);
    const ws = useAtomValue(atoms.workspace);
    const tabBarPosition = useAtomValue(getSettingsKeyAtom("app:tabbar")) ?? "top";
    // MOLTENTERM-PATCH (#1183): the workspace sidebar replaces the tab bar (top or left), the rail and the status bar
    const sidebarOn = useAtomValue(SidebarModel.getInstance().enabledAtom);
    const sidebarHidden = useAtomValue(SidebarModel.getInstance().hiddenAtom);
    // MOLTENTERM-PATCH (#1216): window:tilegapsize is the frame's one margin, outside and between panels
    const frame = frameSizes(useAtomValue(getSettingsKeyAtom("window:tilegapsize")));
    const showLeftTabBar = !sidebarOn && tabBarPosition === "left";
    const aiPanelVisible = useAtomValue(workspaceLayoutModel.panelVisibleAtom);
    const widgetsSidebarVisible = useAtomValue(workspaceLayoutModel.widgetsSidebarVisibleAtom);
    const windowWidth = window.innerWidth;
    const leftGroupInitialPct = workspaceLayoutModel.getLeftGroupInitialPercentage(windowWidth, showLeftTabBar);
    const innerVTabInitialPct = workspaceLayoutModel.getInnerVTabInitialPercentage(windowWidth, showLeftTabBar);
    const innerAIPanelInitialPct = workspaceLayoutModel.getInnerAIPanelInitialPercentage(windowWidth, showLeftTabBar);
    const outerPanelGroupRef = useRef<ImperativePanelGroupHandle>(null);
    const innerPanelGroupRef = useRef<ImperativePanelGroupHandle>(null);
    const aiPanelRef = useRef<ImperativePanelHandle>(null);
    const vtabPanelRef = useRef<ImperativePanelHandle>(null);
    const panelContainerRef = useRef<HTMLDivElement>(null);
    const aiPanelWrapperRef = useRef<HTMLDivElement>(null);
    const vtabPanelWrapperRef = useRef<HTMLDivElement>(null);

    // showLeftTabBar is passed as a seed value only; subsequent changes are handled by setShowLeftTabBar below.
    // Do NOT add showLeftTabBar as a dep here — re-registering refs on config changes would redundantly re-run commitLayouts.
    useEffect(() => {
        if (
            aiPanelRef.current &&
            outerPanelGroupRef.current &&
            innerPanelGroupRef.current &&
            panelContainerRef.current &&
            aiPanelWrapperRef.current
        ) {
            workspaceLayoutModel.registerRefs(
                aiPanelRef.current,
                outerPanelGroupRef.current,
                innerPanelGroupRef.current,
                panelContainerRef.current,
                aiPanelWrapperRef.current,
                vtabPanelRef.current ?? undefined,
                vtabPanelWrapperRef.current ?? undefined,
                showLeftTabBar
            );
        }
    }, []);

    useEffect(() => {
        const isVisible = workspaceLayoutModel.getAIPanelVisible();
        getApi().setWaveAIOpen(isVisible);
    }, []);

    useEffect(() => {
        window.addEventListener("resize", workspaceLayoutModel.handleWindowResize);
        return () => window.removeEventListener("resize", workspaceLayoutModel.handleWindowResize);
    }, []);

    useEffect(() => {
        workspaceLayoutModel.setShowLeftTabBar(showLeftTabBar);
    }, [showLeftTabBar]);

    useEffect(() => {
        const handleFocus = () => workspaceLayoutModel.syncVTabWidthFromMeta();
        window.addEventListener("focus", handleFocus);
        return () => window.removeEventListener("focus", handleFocus);
    }, []);

    const innerHandleVisible = showLeftTabBar && aiPanelVisible;
    const innerHandleClass = `bg-transparent hover:bg-zinc-500/20 transition-colors ${innerHandleVisible ? "w-0.5" : "w-0 pointer-events-none"}`;
    const outerHandleVisible = showLeftTabBar || aiPanelVisible;
    const outerHandleClass = `bg-transparent hover:bg-zinc-500/20 transition-colors ${outerHandleVisible ? "w-0.5" : "w-0 pointer-events-none"}`;

    return (
        <div className="flex flex-col w-full flex-grow overflow-hidden">
            {/* MOLTENTERM-PATCH (#1183): no tab bar under the workspace sidebar */}
            {!sidebarOn && !(showLeftTabBar && isMacOS()) && (
                <TabBar key={ws.oid} workspace={ws} noTabs={showLeftTabBar} />
            )}
            {showLeftTabBar && isMacOS() && <MacOSTabBarSpacer />}
            {/* MOLTENTERM-PATCH (#44, #1183): the workspace rail, or the workspace sidebar, on the left of the content row */}
            <div
                className={`relative flex flex-row flex-grow overflow-hidden ${sidebarOn ? "mt-sb-frame" : ""}`}
                style={sidebarOn ? ({ "--mt-frame-gap": `${frame.marginPx}px` } as React.CSSProperties) : undefined}
            >
            {sidebarOn ? <WorkspaceSidebar /> : MoltentermWorkspaceRail && <WorkspaceRail />}
            {/* MOLTENTERM-PATCH (#1183, #1216): under the sidebar the content sits in the Spaces frame's one margin */}
            <div className={`relative flex min-w-0 flex-grow flex-col overflow-hidden ${sidebarOn ? "mt-frame-content" : ""} ${sidebarOn && !sidebarHidden ? "is-beside" : ""}`}>
            {sidebarOn && <SidebarContentStrip />}
            {/* MOLTENTERM-PATCH (#450): relative, for the pending state drawn over the panels */}
            <div ref={panelContainerRef} className="relative flex min-h-0 flex-row flex-grow overflow-hidden">
                <ErrorBoundary key={tabId}>
                    <PanelGroup
                        direction="horizontal"
                        onLayout={workspaceLayoutModel.handleOuterPanelLayout}
                        ref={outerPanelGroupRef}
                    >
                        <Panel order={0} defaultSize={leftGroupInitialPct} className="overflow-hidden">
                            <PanelGroup
                                direction="horizontal"
                                onLayout={workspaceLayoutModel.handleInnerPanelLayout}
                                ref={innerPanelGroupRef}
                            >
                                <Panel
                                    ref={vtabPanelRef}
                                    collapsible
                                    defaultSize={innerVTabInitialPct}
                                    order={0}
                                    className="overflow-hidden"
                                >
                                    <div ref={vtabPanelWrapperRef} className="w-full h-full">
                                        {showLeftTabBar && <VTabBar workspace={ws} />}
                                    </div>
                                </Panel>
                                {/* MOLTENTERM-PATCH (#1183): a hidden handle is disabled, or its hit area takes the sidebar grip's presses */}
                                <PanelResizeHandle className={innerHandleClass} disabled={!innerHandleVisible} />
                                <Panel
                                    ref={aiPanelRef}
                                    collapsible
                                    defaultSize={innerAIPanelInitialPct}
                                    order={1}
                                    className="overflow-hidden"
                                >
                                    <div
                                        ref={aiPanelWrapperRef}
                                        className={`w-full h-full pr-0.5 ${aiPanelVisible ? "" : "opacity-0"}`}
                                    >
                                        {/* MOLTENTERM-PATCH (#25): the AI panel is not mounted, so nothing can focus its input */}
                                        {tabId !== "" && !MoltentermNoAI && <AIPanel roundTopLeft={showLeftTabBar} />}
                                    </div>
                                </Panel>
                            </PanelGroup>
                        </Panel>
                        <PanelResizeHandle className={outerHandleClass} disabled={!outerHandleVisible} />
                        <Panel order={1} defaultSize={100 - leftGroupInitialPct}>
                            {tabId === "" ? (
                                <CenteredDiv>No Active Tab</CenteredDiv>
                            ) : (
                                <div className="flex flex-row h-full">
                                    {/* MOLTENTERM-PATCH (#1216): framed, the panels take the frame's gap and no padding of their own */}
                                    <TabContent
                                        key={tabId}
                                        tabId={tabId}
                                        noTopPadding={showLeftTabBar && isMacOS()}
                                        frameGapPx={sidebarOn ? frame.gapPx : undefined}
                                    />
                                    {/* MOLTENTERM-PATCH (#110): the widget bar's tools live at the bottom of the workspace rail */}
                                    {widgetsSidebarVisible && !MoltentermToolRail && <Widgets />}
                                </div>
                            )}
                        </Panel>
                    </PanelGroup>
                    <ModalsRenderer />
                </ErrorBoundary>
                {/* MOLTENTERM-PATCH (#450): another workspace's view is loading (FR-PERF-004) */}
                <ViewPendingOverlay />
            </div>
            </div>
            </div>
            {/* MOLTENTERM-PATCH (#55, #1183): the status bar under the content, unless the sidebar holds its items */}
            {MoltentermStatusBar && !sidebarOn && <StatusBar />}
        </div>
    );
});

WorkspaceElem.displayName = "WorkspaceElem";

export { WorkspaceElem as Workspace };
