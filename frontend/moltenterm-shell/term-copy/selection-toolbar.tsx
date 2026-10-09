// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The small bar under a terminal selection (FR-SHELL-017): Copy clean, Open (when the selection names a file of the
// pane) and Send to another pane. It shows once the mouse is released and follows the selection when it scrolls.

import { ContextMenuModel } from "@/app/store/contextmenu";
import type { TermWrap } from "@/app/view/term/termwrap";
import { fireAndForget, useAtomValueSafe } from "@/util/util";
import * as React from "react";
import { parseFileRef } from "./file-links";
import {
    cleanSelectionText,
    copyText,
    HoveredFileLink,
    openFileInPreview,
    otherTermBlocks,
    plainSelectionText,
    sendTextToTerm,
    statSelectionFile,
} from "./term-copy";

const ShowDelayMs = 120;
const BarHeightPx = 24;
const GapPx = 4;
const CopiedMs = 1200;

type BarState = { left: number; top: number; file: HoveredFileLink; canSend: boolean };

// Where the bar goes: under the selection's last visible row, above its first one near the bottom of the pane.
function barPosition(termWrap: TermWrap, container: HTMLElement): { left: number; top: number } {
    const terminal = termWrap.terminal;
    const pos = terminal.getSelectionPosition();
    const screen = termWrap.connectElem.querySelector(".xterm-screen") as HTMLElement;
    if (pos == null || screen == null || container == null) {
        return null;
    }
    const viewportY = terminal.buffer.active.viewportY;
    const startRow = pos.start.y - viewportY;
    const endRow = pos.end.y - viewportY;
    if (endRow < 0 || startRow >= terminal.rows) {
        return null;
    }
    const screenRect = screen.getBoundingClientRect();
    const boxRect = container.getBoundingClientRect();
    const cellH = screenRect.height / terminal.rows;
    const cellW = screenRect.width / terminal.cols;
    const offsetTop = screenRect.top - boxRect.top;
    const offsetLeft = screenRect.left - boxRect.left;
    let top = offsetTop + (Math.min(endRow, terminal.rows - 1) + 1) * cellH + GapPx;
    if (top + BarHeightPx > boxRect.height) {
        top = offsetTop + Math.max(startRow, 0) * cellH - BarHeightPx - GapPx;
    }
    const anchorX = endRow < terminal.rows ? pos.end.x : terminal.cols;
    const left = Math.max(GapPx, Math.min(offsetLeft + anchorX * cellW - 120, boxRect.width - 260));
    return { left, top: Math.max(GapPx, top) };
}

export const TermSelectionToolbar = React.memo(function TermSelectionToolbar({
    termWrap,
    containerRef,
}: {
    termWrap: TermWrap;
    containerRef: React.RefObject<HTMLDivElement>;
}) {
    const [bar, setBar] = React.useState<BarState>(null);
    const [copied, setCopied] = React.useState(false);
    const seqRef = React.useRef(0);
    // xterm keeps a selection when the pane loses the focus; only the focused pane shows the bar.
    const isFocused = useAtomValueSafe(termWrap?.nodeModel?.isFocused);

    React.useEffect(() => {
        if (termWrap == null) {
            return;
        }
        const terminal = termWrap.terminal;
        let mouseDown = false;
        let timer: ReturnType<typeof setTimeout> = null;
        const update = () => {
            timer = null;
            const seq = ++seqRef.current;
            if (mouseDown || !terminal.hasSelection()) {
                setBar(null);
                return;
            }
            const place = barPosition(termWrap, containerRef.current);
            if (place == null) {
                setBar(null);
                return;
            }
            const canSend = otherTermBlocks(termWrap.blockId).length > 0;
            setBar((prev) => ({ ...place, file: prev?.file ?? null, canSend }));
            const ref = parseFileRef(plainSelectionText(termWrap));
            fireAndForget(async () => {
                const file = await statSelectionFile(termWrap, ref);
                if (seq === seqRef.current) {
                    setBar((prev) => (prev == null ? null : { ...prev, file }));
                }
            });
        };
        const schedule = () => {
            if (timer != null) {
                clearTimeout(timer);
            }
            timer = setTimeout(update, ShowDelayMs);
        };
        const onMouseDown = () => {
            mouseDown = true;
            setBar(null);
        };
        const onMouseUp = () => {
            if (!mouseDown) {
                return;
            }
            mouseDown = false;
            schedule();
        };
        const elem = termWrap.connectElem;
        elem.addEventListener("mousedown", onMouseDown);
        window.addEventListener("mouseup", onMouseUp);
        const selDisp = terminal.onSelectionChange(schedule);
        const scrollDisp = terminal.onScroll(schedule);
        const resizeDisp = terminal.onResize(schedule);
        return () => {
            if (timer != null) {
                clearTimeout(timer);
            }
            elem.removeEventListener("mousedown", onMouseDown);
            window.removeEventListener("mouseup", onMouseUp);
            selDisp.dispose();
            scrollDisp.dispose();
            resizeDisp.dispose();
            setBar(null);
        };
    }, [termWrap]);

    if (bar == null || termWrap == null || isFocused === false) {
        return null;
    }

    // The buttons must not take the focus or the selection from the terminal.
    const keepSelection = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };
    const onCopy = () => {
        copyText(cleanSelectionText(termWrap));
        setCopied(true);
        setTimeout(() => setCopied(false), CopiedMs);
    };
    const onOpen = () => {
        if (bar.file == null) {
            return;
        }
        fireAndForget(() => openFileInPreview(bar.file, termWrap.blockId));
    };
    const onSend = (e: React.MouseEvent) => {
        const text = cleanSelectionText(termWrap);
        const menu: ContextMenuItem[] = otherTermBlocks(termWrap.blockId).map((o) => ({
            label: o.label,
            click: () => sendTextToTerm(text, o.blockId),
        }));
        ContextMenuModel.getInstance().showContextMenu(menu, e);
    };
    const buttonClass =
        "cursor-pointer rounded-6 px-1.5 py-0.5 text-secondary hover:bg-hoverbg hover:text-primary transition-colors duration-120 ease-mt";

    return (
        <div
            className="molten-term-selbar xterm-hover absolute z-20 flex items-center gap-0.5 rounded-10 border border-border bg-surface-3 px-0.5 text-12 shadow-e2 select-none"
            style={{ left: bar.left, top: bar.top, height: BarHeightPx }}
            onMouseDown={keepSelection}
            onContextMenu={keepSelection}
        >
            <button
                type="button"
                className={buttonClass}
                onClick={onCopy}
                title="Copy without the agent's padding and gutters"
            >
                {copied ? "Copied" : "Copy clean"}
            </button>
            {bar.file != null && (
                <button type="button" className={buttonClass} onClick={onOpen} title={bar.file.path}>
                    Open
                </button>
            )}
            {bar.canSend && (
                <button type="button" className={buttonClass} onClick={onSend} title="Paste into another terminal">
                    Send to…
                </button>
            )}
        </div>
    );
});

TermSelectionToolbar.displayName = "TermSelectionToolbar";
