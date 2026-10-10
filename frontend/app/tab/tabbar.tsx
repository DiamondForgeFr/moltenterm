// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Tooltip } from "@/app/element/tooltip";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { deleteLayoutModelForTab } from "@/layout/index";
import { isMacOSTahoeOrLater } from "@/util/platformutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { OverlayScrollbars } from "overlayscrollbars";
import { createRef, memo, useCallback, useEffect, useRef, useState } from "react";
import { debounce } from "throttle-debounce";
import { NotificationCenter } from "../../moltenterm-shell/notification-center"; // MOLTENTERM-PATCH (#45)
import { MoltentermNotificationCenter, MoltentermWorkspaceRail } from "../../moltenterm-shell/shell-flags"; // MOLTENTERM-PATCH (#44, #45)
import { checkTabDragReleased } from "../../moltenterm-shell/tab-drag"; // MOLTENTERM-PATCH (#81)
import { layoutTabs, moveTabId, tabDropIndex, tabOffsets } from "../../moltenterm-shell/tab-layout"; // MOLTENTERM-PATCH (#410)
import { measureTab } from "../../moltenterm-shell/tab-measure"; // MOLTENTERM-PATCH (#410)
import { closeTabAskingWorktrees } from "../../moltenterm-shell/worktree-close"; // MOLTENTERM-PATCH (#134)
import { Tab } from "./tab";
import "./tabbar.scss";
import { TabBarEnv } from "./tabbarenv";
import { UpdateStatusBanner } from "./updatebanner";
import { WorkspaceSwitcher } from "./workspaceswitcher";

const TabDefaultWidth = 130;
// MOLTENTERM-PATCH (#410): Wave's TabMinWidth is replaced by the bounds of frontend/moltenterm-shell/tab-layout.ts
const MacOSTrafficLightsWidth = 74;
const MacOSTahoeTrafficLightsWidth = 80;

const OSOptions = {
    overflow: {
        x: "scroll",
        y: "hidden",
    },
    scrollbars: {
        theme: "os-theme-dark",
        visibility: "auto",
        autoHide: "leave",
        autoHideDelay: 1300,
        autoHideSuspend: false,
        dragScroll: true,
        clickScroll: false,
        pointers: ["mouse", "touch", "pen"],
    },
};

interface TabBarProps {
    workspace: Workspace;
    noTabs?: boolean;
}

const WaveAIButton = memo(({ divRef }: { divRef?: React.RefObject<HTMLDivElement> }) => {
    const env = useWaveEnv<TabBarEnv>();
    const aiPanelOpen = useAtomValue(WorkspaceLayoutModel.getInstance().panelVisibleAtom);
    const hideAiButton = useAtomValue(env.getSettingsKeyAtom("app:hideaibutton"));

    const onClick = () => {
        const currentVisible = WorkspaceLayoutModel.getInstance().getAIPanelVisible();
        WorkspaceLayoutModel.getInstance().setAIPanelVisible(!currentVisible);
    };

    if (hideAiButton) {
        return null;
    }

    return (
        <Tooltip
            content="Toggle Wave AI Panel"
            placement="bottom"
            hideOnClick
            divClassName={`flex h-[22px] px-3.5 justify-end mb-1 items-center rounded-md mr-1 box-border cursor-pointer bg-hover hover:bg-hoverbg transition-colors text-[12px] ${aiPanelOpen ? "text-accent" : "text-secondary"}`}
            divStyle={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            divOnClick={onClick}
            divRef={divRef}
        >
            <i className="fa fa-sparkles" />
        </Tooltip>
    );
});
WaveAIButton.displayName = "WaveAIButton";

function strArrayIsEqual(a: string[], b: string[]) {
    // null check
    if (a == null && b == null) {
        return true;
    }
    if (a == null || b == null) {
        return false;
    }
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

const TabBar = memo(({ workspace, noTabs }: TabBarProps) => {
    const env = useWaveEnv<TabBarEnv>();
    const [tabIds, setTabIds] = useState<string[]>([]);
    const [dragStartPositions, setDragStartPositions] = useState<number[]>([]);
    const [draggingTab, setDraggingTab] = useState<string>();
    const [tabsLoaded, setTabsLoaded] = useState({});
    const [newTabId, setNewTabId] = useState<string | null>(null);

    const tabbarWrapperRef = useRef<HTMLDivElement>(null);
    const tabBarRef = useRef<HTMLDivElement>(null);
    const tabsWrapperRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef<React.RefObject<HTMLDivElement>[]>([]);
    const addBtnRef = useRef<HTMLButtonElement>(null);
    const draggingRemovedRef = useRef(false);
    const draggingTabDataRef = useRef({
        tabId: "",
        ref: { current: null },
        tabStartX: 0,
        tabStartIndex: 0,
        tabIndex: 0,
        initialOffsetX: null,
        totalScrollOffset: null,
        dragged: false,
    });
    const osInstanceRef = useRef<OverlayScrollbars>(null);
    const draggerLeftRef = useRef<HTMLDivElement>(null);
    const rightContainerRef = useRef<HTMLDivElement>(null);
    const workspaceSwitcherRef = useRef<HTMLDivElement>(null);
    const waveAIButtonRef = useRef<HTMLDivElement>(null);
    const appMenuButtonRef = useRef<HTMLDivElement>(null);
    const tabWidthRef = useRef<number>(TabDefaultWidth);
    // MOLTENTERM-PATCH (#410): each tab's own width (FR-SHELL-056) and the strip's total
    const tabWidthsRef = useRef<Record<string, number>>({});
    const tabsTotalWidthRef = useRef<number>(0);
    const tabDragActiveRef = useRef<boolean>(false);
    const relayoutTabsRef = useRef<() => void>(null);
    const revealedRef = useRef<string>("");
    const scrollableRef = useRef<boolean>(false);
    const prevAllLoadedRef = useRef<boolean>(false);
    const activeTabId = useAtomValue(env.atoms.staticTabId);
    const isFullScreen = useAtomValue(env.atoms.isFullScreen);
    const zoomFactor = useAtomValue(env.atoms.zoomFactorAtom);
    const showMenuBar = useAtomValue(env.getSettingsKeyAtom("window:showmenubar"));
    const confirmClose = useAtomValue(env.getSettingsKeyAtom("tab:confirmclose")) ?? false;
    const hideAiButton = useAtomValue(env.getSettingsKeyAtom("app:hideaibutton"));
    const appUpdateStatus = useAtomValue(env.atoms.updaterStatusAtom);

    let prevDelta: number;
    let prevDragDirection: string;

    // Update refs when tabIds change
    useEffect(() => {
        tabRefs.current = tabIds.map((_, index) => tabRefs.current[index] || createRef());
    }, [tabIds]);

    useEffect(() => {
        if (!workspace) {
            return;
        }
        const newTabIdsArr = workspace.tabids ?? [];

        const areEqual = strArrayIsEqual(tabIds, newTabIdsArr);

        if (!areEqual) {
            setTabIds(newTabIdsArr);
        }
    }, [workspace, tabIds]);

    // MOLTENTERM-PATCH (#410): widths and offsets come from the layout, not from the boxes, which may be mid-transition
    const widthOfTab = (tabId: string): number => tabWidthsRef.current[tabId] ?? tabWidthRef.current;
    const offsetsOfTabs = (ids: string[]): number[] => tabOffsets(ids.map(widthOfTab));

    const saveTabsPosition = useCallback(() => {
        const tabs = tabRefs.current;
        if (tabs === null) return;
        setDragStartPositions(offsetsOfTabs(tabIds));
    }, [tabIds]);

    const setSizeAndPosition = (animate?: boolean) => {
        const tabBar = tabBarRef.current;
        if (tabBar === null) return;

        const getOuterWidth = (el: HTMLElement): number => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
        };

        const tabbarWrapperWidth = tabbarWrapperRef.current.getBoundingClientRect().width;
        const windowDragLeftWidth = draggerLeftRef.current.getBoundingClientRect().width;
        const rightContainerWidth = rightContainerRef.current?.getBoundingClientRect().width ?? 0;
        const addBtnWidth = getOuterWidth(addBtnRef.current);
        const appMenuButtonWidth = appMenuButtonRef.current?.getBoundingClientRect().width ?? 0;
        const workspaceSwitcherWidth = workspaceSwitcherRef.current?.getBoundingClientRect().width ?? 0;
        const waveAIButtonWidth =
            !hideAiButton && waveAIButtonRef.current != null ? getOuterWidth(waveAIButtonRef.current) : 0;

        const nonTabElementsWidth =
            windowDragLeftWidth +
            rightContainerWidth +
            addBtnWidth +
            appMenuButtonWidth +
            workspaceSwitcherWidth +
            waveAIButtonWidth;
        const spaceForTabs = tabbarWrapperWidth - nonTabElementsWidth;

        // MOLTENTERM-PATCH (#410): each tab takes its content's width (96 to 200 px, the Project tab 32 px); the widest
        // give way first when the strip is short, then it scrolls
        const layout = layoutTabs(
            tabRefs.current.map((ref) => measureTab(ref.current)),
            spaceForTabs
        );
        const newScrollable = layout.scrollable;
        const widths: Record<string, number> = {};

        tabRefs.current.forEach((ref, index) => {
            if (ref.current) {
                if (animate) {
                    ref.current.classList.add("animate");
                } else {
                    ref.current.classList.remove("animate");
                }
                // A tab shown for the first time takes its width at once instead of growing from Wave's default.
                const firstShow = ref.current.style.opacity !== "1";
                if (firstShow) {
                    ref.current.style.transition = "none";
                }
                ref.current.style.width = `${layout.widths[index]}px`;
                ref.current.style.transform = `translate3d(${layout.offsets[index]}px,0,0)`;
                ref.current.style.opacity = "1";
                if (firstShow) {
                    void ref.current.offsetWidth;
                    ref.current.style.transition = "";
                }
                widths[tabIds[index]] = layout.widths[index];
            }
        });
        tabWidthsRef.current = widths;
        tabsTotalWidthRef.current = layout.total;
        if (tabsWrapperRef.current != null && !noTabs) {
            tabsWrapperRef.current.style.width = `${layout.total}px`;
        }
        tabWidthRef.current = layout.widths.length > 0 ? Math.max(...layout.widths) : TabDefaultWidth;

        // Update the state with the new scrollable state if it has changed
        if (newScrollable !== scrollableRef.current) {
            scrollableRef.current = newScrollable;
        }

        // Initialize/destroy overlay scrollbars
        if (newScrollable) {
            osInstanceRef.current = OverlayScrollbars(tabBarRef.current, { ...(OSOptions as any) });
            // MOLTENTERM-PATCH (#410): each tab's page draws its own strip; its active tab is scrolled into view, once
            // per tab count, so a later relayout never takes the strip away from where the user scrolled it
            const activeIndex = tabIds.indexOf(activeTabId);
            const viewport = osInstanceRef.current.elements()?.viewport;
            const revealKey = `${activeTabId}:${tabIds.length}`;
            if (
                activeIndex >= 0 &&
                viewport != null &&
                !tabDragActiveRef.current &&
                revealedRef.current !== revealKey
            ) {
                revealedRef.current = revealKey;
                const left = layout.offsets[activeIndex];
                const right = left + layout.widths[activeIndex];
                if (left < viewport.scrollLeft) {
                    viewport.scrollLeft = left;
                } else if (right > viewport.scrollLeft + viewport.clientWidth) {
                    viewport.scrollLeft = right - viewport.clientWidth;
                }
            }
        } else {
            if (osInstanceRef.current) {
                osInstanceRef.current.destroy();
            }
        }
    };

    const saveTabsPositionDebounced = useCallback(
        debounce(100, () => saveTabsPosition()),
        [saveTabsPosition]
    );

    const handleResizeTabs = useCallback(() => {
        setSizeAndPosition();
        saveTabsPositionDebounced();
    }, [tabIds, newTabId, isFullScreen]);

    // update layout on reinit version
    const reinitVersion = useAtomValue(env.atoms.reinitVersion);
    useEffect(() => {
        if (reinitVersion > 0) {
            setSizeAndPosition();
        }
    }, [reinitVersion]);

    // update layout on resize
    useEffect(() => {
        window.addEventListener("resize", handleResizeTabs);
        return () => {
            window.removeEventListener("resize", handleResizeTabs);
        };
    }, [handleResizeTabs]);

    // update layout on changed tabIds, tabsLoaded, newTabId, hideAiButton, appUpdateStatus, or zoomFactor
    useEffect(() => {
        // Check if all tabs are loaded
        const allLoaded = tabIds.length > 0 && tabIds.every((id) => tabsLoaded[id]);
        if (allLoaded) {
            setSizeAndPosition(false);
            saveTabsPosition();
            if (!prevAllLoadedRef.current) {
                prevAllLoadedRef.current = true;
            }
        }
    }, [tabIds, tabsLoaded, newTabId, saveTabsPosition, hideAiButton, appUpdateStatus, zoomFactor, showMenuBar]);

    // MOLTENTERM-PATCH (#410): a tab's width follows its content, so a rename, a new agent mark or a badge (any change
    // of the tabs' DOM besides attributes) lays the strip out again, easing to the new widths; never during a drag
    relayoutTabsRef.current = () => {
        const allLoaded = tabIds.length > 0 && tabIds.every((id) => tabsLoaded[id]);
        if (!allLoaded || tabDragActiveRef.current) {
            return;
        }
        setSizeAndPosition(true);
        saveTabsPosition();
    };
    useEffect(() => {
        const wrapper = tabsWrapperRef.current;
        if (wrapper == null) {
            return;
        }
        let frame = 0;
        const schedule = () => {
            if (frame !== 0) {
                return;
            }
            frame = requestAnimationFrame(() => {
                frame = 0;
                relayoutTabsRef.current?.();
            });
        };
        const observer = new MutationObserver(schedule);
        observer.observe(wrapper, { childList: true, subtree: true, characterData: true });
        document.fonts?.addEventListener?.("loadingdone", schedule);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
            document.fonts?.removeEventListener?.("loadingdone", schedule);
        };
    }, []);

    const getDragDirection = (currentX: number) => {
        let dragDirection: string;
        if (currentX - prevDelta > 0) {
            dragDirection = "+";
        } else if (currentX - prevDelta === 0) {
            dragDirection = prevDragDirection;
        } else {
            dragDirection = "-";
        }
        prevDelta = currentX;
        prevDragDirection = dragDirection;
        return dragDirection;
    };

    // MOLTENTERM-PATCH (#410): tabs of different widths swap when the dragged tab's centre crosses a neighbour's; the
    // pinned Project tab stays first
    const pinnedTabCount = (): number =>
        tabRefs.current.filter((ref) => ref.current?.dataset.moltenPinned === "true").length;
    const getNewTabIndex = (currentX: number, tabIndex: number, _dragDirection: string) =>
        tabDropIndex(tabIds.map(widthOfTab), tabIndex, currentX, pinnedTabCount());

    const handleMouseMove = (event: MouseEvent) => {
        // MOLTENTERM-PATCH (#81): a release the document never saw ends the drag at the next move
        if (checkTabDragReleased(event)) {
            handleMouseUp(event);
            return;
        }
        const { tabId, ref, tabStartX } = draggingTabDataRef.current;

        let initialOffsetX = draggingTabDataRef.current.initialOffsetX;
        let totalScrollOffset = draggingTabDataRef.current.totalScrollOffset;
        if (initialOffsetX === null) {
            initialOffsetX = event.clientX - tabStartX;
            draggingTabDataRef.current.initialOffsetX = initialOffsetX;
        }
        let currentX = event.clientX - initialOffsetX - totalScrollOffset;
        let tabBarRectWidth = tabBarRef.current.getBoundingClientRect().width;
        // for macos, it's offset to make space for the window buttons
        const tabBarRectLeftOffset = tabBarRef.current.getBoundingClientRect().left;
        const incrementDecrement = tabBarRectLeftOffset * 0.05;
        const dragDirection = getDragDirection(currentX);
        const scrollable = scrollableRef.current;
        const tabWidth = widthOfTab(tabId); // MOLTENTERM-PATCH (#410)

        // Scroll the tab bar if the dragged tab overflows the container bounds
        if (scrollable) {
            const { viewport } = osInstanceRef.current.elements();
            const currentScrollLeft = viewport.scrollLeft;

            if (event.clientX <= tabBarRectLeftOffset) {
                viewport.scrollLeft = Math.max(0, currentScrollLeft - incrementDecrement); // Scroll left
                if (viewport.scrollLeft !== currentScrollLeft) {
                    // Only adjust if the scroll actually changed
                    draggingTabDataRef.current.totalScrollOffset += currentScrollLeft - viewport.scrollLeft;
                }
            } else if (event.clientX >= tabBarRectWidth + tabBarRectLeftOffset) {
                viewport.scrollLeft = Math.min(viewport.scrollWidth, currentScrollLeft + incrementDecrement); // Scroll right
                if (viewport.scrollLeft !== currentScrollLeft) {
                    // Only adjust if the scroll actually changed
                    draggingTabDataRef.current.totalScrollOffset -= viewport.scrollLeft - currentScrollLeft;
                }
            }
        }

        // Re-calculate currentX after potential scroll adjustment
        initialOffsetX = draggingTabDataRef.current.initialOffsetX;
        totalScrollOffset = draggingTabDataRef.current.totalScrollOffset;
        currentX = event.clientX - initialOffsetX - totalScrollOffset;

        setDraggingTab((prev) => (prev !== tabId ? tabId : prev));

        // Check if the tab has moved 5 pixels
        if (Math.abs(currentX - tabStartX) >= 50) {
            draggingTabDataRef.current.dragged = true;
        }

        // Constrain movement within the container bounds
        if (tabBarRef.current) {
            const totalDefaultTabWidth = tabsTotalWidthRef.current; // MOLTENTERM-PATCH (#410): the tabs' own widths
            if (totalDefaultTabWidth < tabBarRectWidth) {
                // Set to the total default tab width if there's vacant space
                tabBarRectWidth = totalDefaultTabWidth;
            } else if (scrollable) {
                // Set to the scrollable width if the tab bar is scrollable
                tabBarRectWidth = tabsWrapperRef.current.scrollWidth;
            }

            const minLeft = offsetsOfTabs(tabIds)[pinnedTabCount()] ?? 0; // MOLTENTERM-PATCH (#410): after the pinned tab
            const maxRight = tabBarRectWidth - tabWidth;

            // Adjust currentX to stay within bounds
            currentX = Math.min(Math.max(currentX, minLeft), maxRight);
        }

        ref.current!.style.transform = `translate3d(${currentX}px,0,0)`;
        ref.current!.style.zIndex = "100";

        const tabIndex = draggingTabDataRef.current.tabIndex;
        const newTabIndex = getNewTabIndex(currentX, tabIndex, dragDirection);

        if (newTabIndex !== tabIndex) {
            // MOLTENTERM-PATCH (#410): the order changes in place (Wave mutates this array during a drag), then every
            // other tab moves to its offset in the new order
            const reordered = moveTabId(tabIds, tabIndex, newTabIndex);
            tabIds.splice(0, tabIds.length, ...reordered);
            draggingRemovedRef.current = true;
            const offsets = offsetsOfTabs(tabIds);

            // Update visual positions of the tabs
            tabIds.forEach((localTabId, index) => {
                const ref = tabRefs.current.find((ref) => ref.current.dataset.tabId === localTabId);
                if (ref.current && localTabId !== tabId) {
                    ref.current.style.transform = `translate3d(${offsets[index]}px,0,0)`;
                    ref.current.classList.add("animate");
                }
            });

            draggingTabDataRef.current.tabIndex = newTabIndex;
        }
    };

    const setUpdatedTabsDebounced = useCallback(
        debounce(300, (tabIds: string[]) => {
            // Reset styles
            tabRefs.current.forEach((ref) => {
                ref.current.style.zIndex = "0";
                ref.current.classList.remove("animate");
            });
            // Reset dragging state
            setDraggingTab(null);
            // Update workspace tab ids
            fireAndForget(() => env.rpc.UpdateWorkspaceTabIdsCommand(TabRpcClient, workspace.oid, tabIds));
        }),
        []
    );

    const handleMouseUp = (_event: MouseEvent) => {
        const { tabIndex, dragged } = draggingTabDataRef.current;

        // Update the final position of the dragged tab
        const draggingTab = tabIds[tabIndex];
        const finalLeftPosition = offsetsOfTabs(tabIds)[tabIndex] ?? 0; // MOLTENTERM-PATCH (#410)
        const ref = tabRefs.current.find((ref) => ref.current.dataset.tabId === draggingTab);
        if (ref.current) {
            ref.current.classList.add("animate");
            ref.current.style.transform = `translate3d(${finalLeftPosition}px,0,0)`;
        }

        if (dragged) {
            setUpdatedTabsDebounced(tabIds);
        } else {
            // Reset styles
            tabRefs.current.forEach((ref) => {
                ref.current.style.zIndex = "0";
                ref.current.classList.remove("animate");
            });
            // Reset dragging state
            setDraggingTab(null);
        }

        document.removeEventListener("mouseup", handleMouseUp);
        document.removeEventListener("mousemove", handleMouseMove);
        draggingRemovedRef.current = false;
        tabDragActiveRef.current = false; // MOLTENTERM-PATCH (#410)
    };

    const handleDragStart = useCallback(
        (event: React.MouseEvent<HTMLDivElement, MouseEvent>, tabId: string, ref: React.RefObject<HTMLDivElement>) => {
            if (event.button !== 0) return;

            // MOLTENTERM-PATCH (#410): the pinned Project tab activates on press (DS-SHELL-098) and does not move
            if (ref.current?.dataset.moltenPinned === "true") {
                draggingTabDataRef.current.dragged = false;
                env.electron.setActiveTab(tabId);
                return;
            }

            const tabIndex = tabIds.indexOf(tabId);
            // MOLTENTERM-PATCH (#410): from the current order, which a previous drag changed in place without a render
            const tabStartX = offsetsOfTabs(tabIds)[tabIndex] ?? dragStartPositions[tabIndex]; // Starting X position of the tab

            console.log("handleDragStart", tabId, tabIndex, tabStartX);
            if (ref.current) {
                draggingTabDataRef.current = {
                    tabId: ref.current.dataset.tabId,
                    ref,
                    tabStartX,
                    tabIndex,
                    tabStartIndex: tabIndex,
                    initialOffsetX: null,
                    totalScrollOffset: 0,
                    dragged: false,
                };

                // MOLTENTERM-PATCH (#410): the pressed tab follows the pointer without easing; no relayout meanwhile
                ref.current.classList.remove("animate");
                tabDragActiveRef.current = true;
                document.addEventListener("mousemove", handleMouseMove);
                document.addEventListener("mouseup", handleMouseUp);
            }
        },
        [tabIds, dragStartPositions]
    );

    const handleSelectTab = (tabId: string) => {
        // MOLTENTERM-PATCH (#410): the pinned Project tab was already activated by its press
        const pinned = tabRefs.current.some(
            (ref) => ref.current?.dataset.tabId === tabId && ref.current.dataset.moltenPinned === "true"
        );
        if (pinned) {
            return;
        }
        if (!draggingTabDataRef.current.dragged) {
            env.electron.setActiveTab(tabId);
        }
    };

    const updateScrollDebounced = useCallback(
        debounce(30, () => {
            if (scrollableRef.current) {
                const { viewport } = osInstanceRef.current.elements();
                viewport.scrollLeft = viewport.scrollWidth; // MOLTENTERM-PATCH (#410): tabs have their own widths
            }
        }),
        [tabIds]
    );

    const setNewTabIdDebounced = useCallback(
        debounce(100, (tabId: string) => {
            setNewTabId(tabId);
        }),
        []
    );

    const handleAddTab = () => {
        env.electron.createTab();
        tabsWrapperRef.current.style.setProperty("--tabs-wrapper-transition", "width 0.1s ease");

        updateScrollDebounced();

        setNewTabIdDebounced(null);
    };

    const handleCloseTab = (event: React.MouseEvent<HTMLButtonElement, MouseEvent> | null, tabId: string) => {
        event?.stopPropagation();
        // MOLTENTERM-PATCH (#134): a tab holding terminals linked to worktrees asks once for all of them
        closeTabAskingWorktrees(env.electron.closeTab, workspace.oid, tabId, confirmClose)
            .then((didClose) => {
                if (didClose) {
                    tabsWrapperRef.current?.style.setProperty("--tabs-wrapper-transition", "width 0.3s ease");
                    deleteLayoutModelForTab(tabId);
                }
            })
            .catch((e) => {
                console.log("error closing tab", e);
            });
    };

    const handleTabLoaded = useCallback((tabId: string) => {
        setTabsLoaded((prev) => {
            if (!prev[tabId]) {
                // Only update if the tab isn't already marked as loaded
                return { ...prev, [tabId]: true };
            }
            return prev;
        });
    }, []);

    const activeTabIndex = tabIds.indexOf(activeTabId);

    function onEllipsisClick() {
        env.electron.showWorkspaceAppMenu(workspace.oid);
    }

    // MOLTENTERM-PATCH (#410): the sum of the tabs' own widths, kept up to date by setSizeAndPosition
    const tabsWrapperWidth = tabsTotalWidthRef.current || tabIds.length * tabWidthRef.current;
    const showAppMenuButton = env.isWindows() || (!env.isMacOS() && !showMenuBar);

    // Calculate window drag left width based on platform and state
    let windowDragLeftWidth = 10;
    if (env.isMacOS() && !isFullScreen) {
        const trafficLightsWidth = isMacOSTahoeOrLater() ? MacOSTahoeTrafficLightsWidth : MacOSTrafficLightsWidth;
        if (zoomFactor > 0) {
            windowDragLeftWidth = trafficLightsWidth / zoomFactor;
        } else {
            windowDragLeftWidth = trafficLightsWidth;
        }
    }

    // Calculate window drag right width
    let windowDragRightWidth = 12;
    if (env.isWindows()) {
        if (zoomFactor > 0) {
            windowDragRightWidth = 139 / zoomFactor;
        } else {
            windowDragRightWidth = 139;
        }
    }

    return (
        <div ref={tabbarWrapperRef} className="tab-bar-wrapper">
            <div
                ref={draggerLeftRef}
                className="h-full shrink-0 z-window-drag"
                style={{ width: windowDragLeftWidth, WebkitAppRegion: "drag" } as any}
            />
            {showAppMenuButton && (
                <div
                    ref={appMenuButtonRef}
                    className="flex items-center justify-center pr-1.5 text-[26px] select-none cursor-pointer text-secondary hover:text-primary"
                    style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                    onClick={onEllipsisClick}
                >
                    <i className="fa fa-ellipsis" />
                </div>
            )}
            <WaveAIButton divRef={waveAIButtonRef} />
            {/* MOLTENTERM-PATCH (#44): workspaces are switched from the rail on the left (frontend/moltenterm-shell/workspace-rail.tsx) */}
            {!MoltentermWorkspaceRail && (
                <Tooltip
                    content="Workspace Switcher"
                    placement="bottom"
                    hideOnClick
                    divRef={workspaceSwitcherRef}
                    divClassName="flex items-center"
                >
                    <WorkspaceSwitcher />
                </Tooltip>
            )}
            <div className="tab-bar" ref={tabBarRef} data-overlayscrollbars-initialize>
                <div
                    className="tabs-wrapper"
                    ref={tabsWrapperRef}
                    style={{
                        width: noTabs ? 0 : tabsWrapperWidth,
                        ...(noTabs ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : {}),
                    }}
                >
                    {!noTabs &&
                        tabIds.map((tabId, index) => {
                            const isActive = activeTabId === tabId;
                            const showDivider = index !== 0 && !isActive && index !== activeTabIndex + 1;
                            return (
                                <Tab
                                    key={tabId}
                                    ref={tabRefs.current[index]}
                                    id={tabId}
                                    showDivider={showDivider}
                                    onSelect={() => handleSelectTab(tabId)}
                                    active={isActive}
                                    onDragStart={(event) => handleDragStart(event, tabId, tabRefs.current[index])}
                                    onClose={(event) => handleCloseTab(event, tabId)}
                                    onLoaded={() => handleTabLoaded(tabId)}
                                    isDragging={draggingTab === tabId}
                                    tabWidth={tabWidthRef.current}
                                    isNew={tabId === newTabId}
                                />
                            );
                        })}
                </div>
            </div>
            <button
                ref={addBtnRef}
                title="Add Tab"
                className={`flex h-[22px] px-2 mb-1 mx-1 items-center rounded-md box-border cursor-pointer hover:bg-hoverbg transition-colors text-[12px] text-secondary hover:text-primary${noTabs ? " invisible" : ""}`}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                onClick={handleAddTab}
            >
                <i className="fa fa-solid fa-plus" />
            </button>
            <div className="flex-1" />
            <div ref={rightContainerRef} className="flex flex-row gap-1 items-end">
                {/* MOLTENTERM-PATCH (#45): the notification center's bell */}
                {MoltentermNotificationCenter && <NotificationCenter />}
                <UpdateStatusBanner />
                <div
                    className="h-full shrink-0 z-window-drag"
                    style={{ width: windowDragRightWidth, WebkitAppRegion: "drag" } as any}
                />
            </div>
        </div>
    );
});

export { TabBar, WaveAIButton };
