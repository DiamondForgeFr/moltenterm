// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getTabBadgeAtom } from "@/app/store/badge";
import { refocusNode } from "@/app/store/global";
import { getTabModelByTabId } from "@/app/store/tab-model";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WaveEnv, WaveEnvSubset, useWaveEnv } from "@/app/waveenv/waveenv";
import { Button } from "@/element/button";
import { validateCssColor } from "@/util/color-validator";
import { fireAndForget } from "@/util/util";
import clsx from "clsx";
import { useAtomValue } from "jotai";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { HoldToCloseButton } from "../../moltenterm-shell/hold-to-close"; // MOLTENTERM-PATCH (#255)
import "../../moltenterm-shell/tab-bar.css"; // MOLTENTERM-PATCH (#410)
import { TabAgentMark, TabIcon, useTabIdentity } from "../../moltenterm-shell/tab-identity-ui"; // MOLTENTERM-PATCH (#410)
import { useTabTreesTooltip } from "../../moltenterm-shell/worktree-ui"; // MOLTENTERM-PATCH (#114)
import { makeORef } from "../store/wos";
import "./tab.scss";
import { TabBadges } from "./tabbadges";
import { buildTabContextMenu } from "./tabcontextmenu";

export type TabEnv = WaveEnvSubset<{
    rpc: {
        ActivityCommand: WaveEnv["rpc"]["ActivityCommand"];
        SetConfigCommand: WaveEnv["rpc"]["SetConfigCommand"];
        SetMetaCommand: WaveEnv["rpc"]["SetMetaCommand"];
        UpdateTabNameCommand: WaveEnv["rpc"]["UpdateTabNameCommand"];
    };
    atoms: {
        fullConfigAtom: WaveEnv["atoms"]["fullConfigAtom"];
    };
    wos: WaveEnv["wos"];
    getSettingsKeyAtom: WaveEnv["getSettingsKeyAtom"];
    showContextMenu: WaveEnv["showContextMenu"];
}>;

interface TabVProps {
    tabId: string;
    tabName: string;
    active: boolean;
    showDivider: boolean;
    isDragging: boolean;
    tabWidth: number;
    isNew: boolean;
    badges?: Badge[] | null;
    flagColor?: string | null;
    agentDot?: React.ReactNode; // MOLTENTERM-PATCH (#109)
    icon?: string; // MOLTENTERM-PATCH (#410)
    pinned?: boolean; // MOLTENTERM-PATCH (#410): the Project tab, drawn as its icon alone
    treesTitle?: string; // MOLTENTERM-PATCH (#114)
    onTreesHover?: () => void; // MOLTENTERM-PATCH (#114)
    onClick: () => void;
    onClose: (event: React.MouseEvent<HTMLButtonElement, MouseEvent> | null) => void;
    onDragStart: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
    onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
    onRename: (newName: string) => void;
    /** Optional ref that TabV populates with a startRename() function for external callers */
    renameRef?: React.RefObject<(() => void) | null>;
}

const TabV = forwardRef<HTMLDivElement, TabVProps>((props, ref) => {
    const {
        tabId,
        tabName,
        active,
        showDivider,
        isDragging,
        tabWidth,
        isNew,
        badges,
        flagColor,
        agentDot,
        icon,
        pinned,
        treesTitle,
        onTreesHover,
        onClick,
        onClose,
        onDragStart,
        onContextMenu,
        onRename,
        renameRef,
    } = props;
    // MOLTENTERM-PATCH (#410): the name is shown whole and ellipsized by the tab's width, not cut at 14 characters
    const truncateTabName = (name: string) => name ?? "";
    const displayName = truncateTabName(tabName);
    const [originalName, setOriginalName] = useState(displayName);
    const [isEditable, setIsEditable] = useState(false);

    const editableRef = useRef<HTMLDivElement>(null);
    const editableTimeoutRef = useRef<NodeJS.Timeout>(null);
    const tabRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => tabRef.current as HTMLDivElement);

    useEffect(() => {
        setOriginalName(truncateTabName(tabName));
    }, [tabName]);

    useEffect(() => {
        return () => {
            if (editableTimeoutRef.current) {
                clearTimeout(editableTimeoutRef.current);
            }
        };
    }, []);

    const selectEditableText = useCallback(() => {
        if (!editableRef.current) {
            return;
        }
        editableRef.current.focus();
        const range = document.createRange();
        const selection = window.getSelection();
        if (!selection) {
            return;
        }
        range.selectNodeContents(editableRef.current);
        selection.removeAllRanges();
        selection.addRange(range);
    }, []);

    const startRename = useCallback(() => {
        setIsEditable(true);
        editableTimeoutRef.current = setTimeout(() => {
            selectEditableText();
        }, 50);
    }, [selectEditableText]);

    const handleRenameTab: React.MouseEventHandler<HTMLDivElement> = useCallback(
        (event) => {
            event?.stopPropagation();
            startRename();
        },
        [startRename]
    );

    // MOLTENTERM-PATCH (#410): the pinned Project tab has no name to edit (its double-click lands on the icon)
    const handleDoubleClick: React.MouseEventHandler<HTMLDivElement> = (event) => {
        if (!pinned) {
            return;
        }
        event.stopPropagation();
    };

    // Expose startRename to external callers (e.g. context menu in TabInner)
    if (renameRef != null) {
        renameRef.current = startRename;
    }

    const handleBlur = () => {
        if (!editableRef.current) return;
        let newText = editableRef.current.innerText.trim();
        newText = newText || originalName;
        editableRef.current.innerText = newText;
        setIsEditable(false);
        onRename(newText);
    };

    const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "a") {
            event.preventDefault();
            selectEditableText();
            return;
        }
        if (!editableRef.current) return;
        const curLen = Array.from(editableRef.current.innerText).length;
        if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            if (editableRef.current.innerText.trim() === "") {
                editableRef.current.innerText = originalName;
            }
            editableRef.current.blur();
        } else if (event.key === "Escape") {
            editableRef.current.innerText = originalName;
            editableRef.current.blur();
            event.preventDefault();
            event.stopPropagation();
        } else if (curLen >= 14 && !["Backspace", "Delete", "ArrowLeft", "ArrowRight"].includes(event.key)) {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed) {
                event.preventDefault();
                event.stopPropagation();
            }
        }
    };

    useEffect(() => {
        if (tabRef.current && isNew) {
            const initialWidth = `${(tabWidth / 3) * 2}px`;
            tabRef.current.style.setProperty("--initial-tab-width", initialWidth);
            tabRef.current.style.setProperty("--final-tab-width", `${tabWidth}px`);
        }
    }, [isNew, tabWidth]);

    const handleMouseDownOnClose = (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
        event.stopPropagation();
    };

    // MOLTENTERM-PATCH (#255): a middle-click closes the tab at once, through the same handler as the close button
    const handleAuxClick = (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        if (event.button !== 1 || isEditable) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        onClose(null);
    };

    // MOLTENTERM-PATCH (#81): while the name is edited, pressing places the caret or selects text; it never drags the tab
    const handleMouseDown = (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        if (isEditable) {
            return;
        }
        onDragStart(event);
    };

    // MOLTENTERM-PATCH (#410): an ellipsized name shows in full on hover (above the trees of the tab's terminals)
    const handleMouseEnter = () => {
        onTreesHover?.();
        const nameEl = editableRef.current;
        if (nameEl == null || isEditable) {
            return;
        }
        const truncated = nameEl.scrollWidth > nameEl.clientWidth;
        nameEl.title = truncated ? [displayName, treesTitle].filter((s) => !!s).join("\n") : "";
    };

    return (
        <div
            ref={tabRef}
            className={clsx("tab", {
                active,
                dragging: isDragging,
                "new-tab": isNew,
                "molten-tab": true, // MOLTENTERM-PATCH (#410): frontend/moltenterm-shell/tab-bar.css
                "molten-tab-pinned": pinned, // MOLTENTERM-PATCH (#410)
            })}
            onMouseDown={handleMouseDown}
            onClick={onClick}
            onDoubleClick={handleDoubleClick} // MOLTENTERM-PATCH (#410)
            onAuxClick={handleAuxClick} // MOLTENTERM-PATCH (#255)
            onContextMenu={onContextMenu}
            data-tab-id={tabId}
            data-molten-pinned={pinned ? "true" : undefined} // MOLTENTERM-PATCH (#410): read by the tab bar's layout
            // MOLTENTERM-PATCH (#114, #410): the tooltip lists the trees of the tab's terminals; the Project tab says what it is
            title={(pinned ? displayName : treesTitle) || undefined}
            aria-label={pinned ? displayName : undefined}
            onMouseEnter={handleMouseEnter} // MOLTENTERM-PATCH (#114, #410)
        >
            {showDivider && <div className="tab-divider" />}
            <div className="tab-inner">
                {/* MOLTENTERM-PATCH (#410): the view's or the agent's icon, then the name, the agent mark and the badges */}
                <TabIcon icon={icon} />
                <div className="molten-tab-body">
                    <div
                        ref={editableRef}
                        className={clsx("name", { focused: isEditable })}
                        contentEditable={isEditable}
                        onDoubleClick={handleRenameTab}
                        onBlur={handleBlur}
                        onKeyDown={handleKeyDown}
                        suppressContentEditableWarning={true}
                    >
                        {displayName}
                    </div>
                    {/* MOLTENTERM-PATCH (#109): the most urgent state of the tab's coding agents */}
                    {agentDot}
                    <TabBadges
                        badges={badges}
                        flagColor={flagColor}
                        className="static w-auto translate-y-0" // MOLTENTERM-PATCH (#410): in the row, after the name
                    />
                </div>
                {/* MOLTENTERM-PATCH (#255, #271): the close button closes after a press-and-hold (FR-SHELL-025) */}
                {!pinned && (
                    <HoldToCloseButton
                        as={Button}
                        className="ghost grey close"
                        onClose={onClose}
                        onMouseDown={handleMouseDownOnClose}
                        plainTitle="Close Tab"
                    />
                )}
            </div>
        </div>
    );
});

TabV.displayName = "TabV";

interface TabProps {
    id: string;
    active: boolean;
    showDivider: boolean;
    isDragging: boolean;
    tabWidth: number;
    isNew: boolean;
    onSelect: () => void;
    onClose: (event: React.MouseEvent<HTMLButtonElement, MouseEvent> | null) => void;
    onDragStart: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
    onLoaded: () => void;
}

const TabInner = forwardRef<HTMLDivElement, TabProps>((props, ref) => {
    const { id, active, showDivider, isDragging, tabWidth, isNew, onLoaded, onSelect, onClose, onDragStart } = props;
    const env = useWaveEnv<TabEnv>();
    const [tabData, _] = env.wos.useWaveObjectValue<Tab>(makeORef("tab", id));
    const badges = useAtomValue(getTabBadgeAtom(id, env));
    const trees = useTabTreesTooltip(id); // MOLTENTERM-PATCH (#114)
    const identity = useTabIdentity(id, tabData?.name ?? ""); // MOLTENTERM-PATCH (#410)

    const rawFlagColor = tabData?.meta?.["tab:flagcolor"];
    let flagColor: string | null = null;
    if (rawFlagColor) {
        try {
            validateCssColor(rawFlagColor);
            flagColor = rawFlagColor;
        } catch {
            flagColor = null;
        }
    }

    const loadedRef = useRef(false);
    const renameRef = useRef<(() => void) | null>(null);
    const tabModel = getTabModelByTabId(id, env);

    useEffect(() => {
        if (!loadedRef.current) {
            onLoaded();
            loadedRef.current = true;
        }
    }, [onLoaded]);

    useEffect(() => {
        const cb = () => renameRef.current?.();
        tabModel.startRenameCallback = cb;
        return () => {
            if (tabModel.startRenameCallback === cb) {
                tabModel.startRenameCallback = null;
            }
        };
    }, [tabModel]);

    const handleTabClick = () => {
        onSelect();
    };

    const handleContextMenu = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            e.preventDefault();
            const menu = buildTabContextMenu(id, renameRef, onClose, env);
            env.showContextMenu(menu, e);
        },
        [id, onClose, env]
    );

    const handleRename = useCallback(
        (newName: string) => {
            fireAndForget(() => env.rpc.UpdateTabNameCommand(TabRpcClient, id, newName));
            setTimeout(() => refocusNode(null), 10);
        },
        [id, env]
    );

    return (
        <TabV
            ref={ref}
            tabId={id}
            tabName={identity.name} // MOLTENTERM-PATCH (#410): the first panel's title in place of T<n>
            active={active}
            showDivider={showDivider}
            isDragging={isDragging}
            tabWidth={tabWidth}
            isNew={isNew}
            badges={badges}
            flagColor={flagColor}
            agentDot={<TabAgentMark info={identity.agent} />} // MOLTENTERM-PATCH (#109, #410): shaped per state
            icon={identity.icon} // MOLTENTERM-PATCH (#410)
            pinned={identity.pinned} // MOLTENTERM-PATCH (#113, #410)
            treesTitle={trees.title}
            onTreesHover={trees.onMouseEnter}
            onClick={handleTabClick}
            onClose={onClose}
            onDragStart={onDragStart}
            onContextMenu={handleContextMenu}
            onRename={handleRename}
            renameRef={renameRef}
        />
    );
});
const Tab = memo(TabInner);
Tab.displayName = "Tab";

export { Tab, TabV };
