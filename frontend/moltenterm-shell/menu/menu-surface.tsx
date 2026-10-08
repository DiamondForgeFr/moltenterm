// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { isMacOS } from "@/util/platformutil";
import {
    autoUpdate,
    flip,
    FloatingFocusManager,
    FloatingNode,
    FloatingPortal,
    FloatingTree,
    offset,
    safePolygon,
    shift,
    size,
    useClick,
    useFloating,
    useFloatingNodeId,
    useFloatingParentNodeId,
    useFloatingTree,
    useHover,
    useInteractions,
    useListNavigation,
    useTypeahead,
} from "@floating-ui/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { actionableMenuItem, menuItemRole, menuLabel, visibleMenuItems } from "./menu-model";
import "./menu.css";

type MenuProps = {
    items: ContextMenuItem[];
    point?: { x: number; y: number };
    item?: ContextMenuItem;
    parentProps?: Record<string, any>;
    parentRef?: (element: HTMLElement) => void;
    onSelect: (item: ContextMenuItem) => void;
    onCancel: () => void;
    portalRoot?: HTMLElement;
};
function shortcutLabel(accelerator: string): string {
    if (!accelerator) return "";
    if (!isMacOS()) return accelerator.replace(/Control/g, "Ctrl").replace(/Super/g, "Meta");
    return accelerator
        .replace(/Control\+/g, "⌃")
        .replace(/(?:Option|Alt)\+/g, "⌥")
        .replace(/Shift\+/g, "⇧")
        .replace(/(?:Command|Cmd)\+/g, "⌘");
}
function MenuBranch({ items, point, item, parentProps, parentRef, onSelect, onCancel, portalRoot }: MenuProps) {
    const parentId = useFloatingParentNodeId();
    const nested = parentId != null;
    const tree = useFloatingTree();
    const nodeId = useFloatingNodeId();
    const [open, setOpen] = useState(!nested);
    const [activeIndex, setActiveIndex] = useState<number>(() => {
        const index = visibleMenuItems(items).findIndex(actionableMenuItem);
        return index < 0 ? null : index;
    });
    useEffect(() => {
        const closeSibling = (event: { parentId: string; nodeId: string }) => {
            if (event.parentId === parentId && event.nodeId !== nodeId) setOpen(false);
        };
        tree?.events.on("menuopen", closeSibling);
        return () => tree?.events.off("menuopen", closeSibling);
    }, [tree, parentId, nodeId]);
    useEffect(() => {
        if (nested && open) tree?.events.emit("menuopen", { parentId, nodeId });
    }, [tree, parentId, nodeId, nested, open]);
    const listRef = useRef<Array<HTMLElement>>([]);
    const labelsRef = useRef<Array<string>>([]);
    const visible = useMemo(() => visibleMenuItems(items), [items]);
    labelsRef.current = visible.map((entry) => (actionableMenuItem(entry) ? menuLabel(entry) : null));
    const { refs, floatingStyles, context, isPositioned } = useFloating({
        nodeId,
        open,
        onOpenChange: setOpen,
        placement: nested ? "right-start" : "bottom-start",
        strategy: "fixed",
        whileElementsMounted: autoUpdate,
        middleware: [
            offset(nested ? -2 : 2),
            flip({ padding: 8 }),
            shift({ padding: 8, crossAxis: true }),
            size({
                padding: 8,
                apply({ availableHeight, availableWidth, elements }) {
                    Object.assign(elements.floating.style, {
                        maxHeight: `${availableHeight}px`,
                        maxWidth: `${availableWidth}px`,
                    });
                },
            }),
        ],
    });
    useLayoutEffect(() => {
        if (!point) return;
        refs.setPositionReference({
            getBoundingClientRect: () => ({
                x: point.x,
                y: point.y,
                top: point.y,
                left: point.x,
                right: point.x,
                bottom: point.y,
                width: 0,
                height: 0,
                toJSON: () => ({}),
            }),
        });
    }, [point, refs]);
    const mountPanel = useCallback(
        (element: HTMLDivElement) => {
            refs.setFloating(element);
            if (!element) return;
            const index = visible.findIndex(actionableMenuItem);
            setActiveIndex(index < 0 ? null : index);
        },
        [refs, visible]
    );
    useLayoutEffect(() => {
        if (!open || !isPositioned) return;
        const index = visible.findIndex(actionableMenuItem);
        setActiveIndex(index < 0 ? null : index);
        const target = listRef.current[index] ?? refs.floating.current;
        target?.focus({ preventScroll: true });
    }, [open, isPositioned, visible, refs]);
    const hover = useHover(context, {
        enabled: nested && item?.enabled !== false,
        delay: { open: 150 },
        handleClose: safePolygon({ blockPointerEvents: false }),
    });
    const click = useClick(context, { enabled: nested && item?.enabled !== false, event: "mousedown", toggle: false });
    const navigation = useListNavigation(context, {
        listRef,
        activeIndex,
        onNavigate: setActiveIndex,
        nested,
        loop: true,
        orientation: "vertical",
        disabledIndices: visible.flatMap((entry, i) => (actionableMenuItem(entry) ? [] : [i])),
    });
    const typeahead = useTypeahead(context, { listRef: labelsRef, activeIndex, onMatch: setActiveIndex });
    const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
        hover,
        click,
        navigation,
        typeahead,
    ]);
    useEffect(() => {
        if (open && activeIndex != null) listRef.current[activeIndex]?.scrollIntoView({ block: "nearest" });
    }, [open, activeIndex]);
    const close = () => {
        if (nested) {
            setOpen(false);
            (refs.domReference.current as HTMLElement)?.focus();
        } else onCancel();
    };
    return (
        <FloatingNode id={nodeId}>
            {nested && (
                <button
                    {...getReferenceProps(parentProps)}
                    ref={(element) => {
                        refs.setReference(element);
                        parentRef?.(element);
                    }}
                    type="button"
                    className="molten-menu-item cursor-pointer"
                    role={menuItemRole(item)}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    disabled={item.enabled === false}
                    data-context-menu-item={menuLabel(item)}
                >
                    <MenuItemContent item={item} submenu />
                </button>
            )}
            {open && (
                <FloatingPortal root={portalRoot} preserveTabOrder={false}>
                    <FloatingFocusManager context={context} modal={false} initialFocus={-1} returnFocus={false}>
                        <div
                            {...getFloatingProps({
                                onKeyDown(event: React.KeyboardEvent) {
                                    event.stopPropagation();
                                    if (event.key === "Escape" || (nested && event.key === "ArrowLeft")) {
                                        event.preventDefault();
                                        close();
                                    }
                                    if (event.key === "Tab") {
                                        event.preventDefault();
                                        onCancel();
                                    }
                                },
                            })}
                            ref={mountPanel}
                            style={{ ...floatingStyles, visibility: isPositioned ? "visible" : "hidden" }}
                            className="molten-menu"
                            role="menu"
                            tabIndex={-1}
                            aria-label={item ? menuLabel(item) : "Context menu"}
                        >
                            {visible.map((entry, index) => {
                                if (entry.type === "separator")
                                    return <div key={index} className="molten-menu-separator" role="separator" />;
                                if (entry.type === "header")
                                    return (
                                        <div key={index} className="molten-menu-header" role="presentation">
                                            {menuLabel(entry)}
                                        </div>
                                    );
                                const props = getItemProps({
                                    tabIndex: activeIndex === index ? 0 : -1,
                                    onFocus: () => setActiveIndex(index),
                                });
                                const ref = (element: HTMLElement) => {
                                    listRef.current[index] = element;
                                };
                                if (visibleMenuItems(entry.submenu ?? []).length)
                                    return (
                                        <MenuBranch
                                            key={index}
                                            items={entry.submenu}
                                            item={entry}
                                            parentProps={props}
                                            parentRef={ref}
                                            onSelect={onSelect}
                                            onCancel={onCancel}
                                            portalRoot={portalRoot}
                                        />
                                    );
                                return (
                                    <button
                                        {...props}
                                        key={index}
                                        ref={ref}
                                        type="button"
                                        className="molten-menu-item cursor-pointer"
                                        role={menuItemRole(entry)}
                                        disabled={entry.enabled === false}
                                        aria-checked={
                                            entry.type === "checkbox" || entry.type === "radio"
                                                ? !!entry.checked
                                                : undefined
                                        }
                                        data-context-menu-item={menuLabel(entry)}
                                        data-destructive={entry.destructive || undefined}
                                        onClick={() => onSelect(entry)}
                                    >
                                        <MenuItemContent item={entry} />
                                    </button>
                                );
                            })}
                        </div>
                    </FloatingFocusManager>
                </FloatingPortal>
            )}
        </FloatingNode>
    );
}
function MenuItemContent({ item, submenu }: { item: ContextMenuItem; submenu?: boolean }) {
    return (
        <>
            <span className="molten-menu-icon" aria-hidden="true">
                {item.checked ? (
                    item.type === "radio" ? (
                        "●"
                    ) : (
                        "✓"
                    )
                ) : item.icon ? (
                    <i className={`fa fa-${item.icon}`} />
                ) : null}
            </span>
            <span className="molten-menu-label">
                <span>{menuLabel(item)}</span>
                {item.sublabel && <span className="molten-menu-sublabel">{item.sublabel}</span>}
            </span>
            <span className="molten-menu-shortcut">{shortcutLabel(item.accelerator)}</span>
            {submenu && (
                <span aria-hidden="true" className="molten-menu-chevron">
                    ›
                </span>
            )}
        </>
    );
}
export function MenuSurface(props: MenuProps) {
    return (
        <FloatingTree>
            <MenuBranch {...props} />
        </FloatingTree>
    );
}
