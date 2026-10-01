// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Draws the boxes mods show through `api.boxes` (FR-MORPH-007). They live in the host's own layer and are placed
// over the bottom-right corner of their terminal block, found by its `data-blockid`, so Wave's layout is not
// patched. The layer follows the block when the layout moves, and drops the boxes of a block that is gone.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { MoltenBoxAction } from "./molten-api";
import type { MoltenBoxEntry, MoltenHost } from "./molten-host";

const PositionPollMs = 250;
const ActionFeedbackMs = 1500;
// Polls in a row without the block before its boxes close: a block re-mounting during a layout change comes back.
const MissingBlockPolls = 4;

type Anchor = { right: number; bottom: number; maxWidth: number };

function anchorFor(blockId: string): Anchor {
    const elem = document.querySelector(`[data-blockid="${CSS.escape(blockId)}"]`);
    if (elem == null) {
        return null;
    }
    const rect = elem.getBoundingClientRect();
    return {
        right: Math.max(8, window.innerWidth - rect.right + 12),
        bottom: Math.max(8, window.innerHeight - rect.bottom + 12),
        maxWidth: Math.max(220, Math.min(460, rect.width - 24)),
    };
}

function sameAnchor(a: Anchor, b: Anchor): boolean {
    return a?.right === b?.right && a?.bottom === b?.bottom && a?.maxWidth === b?.maxWidth;
}

function BoxActionButton({ action }: { action: MoltenBoxAction }) {
    const [feedback, setFeedback] = useState<string>(null);
    useEffect(() => {
        if (feedback == null) {
            return;
        }
        const timer = setTimeout(() => setFeedback(null), ActionFeedbackMs);
        return () => clearTimeout(timer);
    }, [feedback]);
    const onClick = async () => {
        try {
            const message = await action.run();
            setFeedback(typeof message === "string" && message !== "" ? message : null);
        } catch (e) {
            setFeedback("Failed");
        }
    };
    return (
        <button
            type="button"
            title={action.label}
            aria-label={action.label}
            className={cn(
                "flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-secondary hover:bg-hover hover:text-primary",
                feedback != null && "text-accent hover:text-accent"
            )}
            onClick={onClick}
        >
            <i className={cn("fa fa-solid", feedback != null ? "fa-check" : `fa-${action.icon ?? "play"}`)} />
            {feedback != null ? <span className="text-xs">{feedback}</span> : null}
        </button>
    );
}

function MoltenBox({ host, box }: { host: MoltenHost; box: MoltenBoxEntry }) {
    return (
        <div
            role="dialog"
            aria-label={box.title ?? "Box"}
            tabIndex={-1}
            onKeyDown={(e) => {
                if (e.key !== "Escape") {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                host.dismissBox(box.id);
            }}
            className="molten-box pointer-events-auto flex w-full flex-col rounded border border-border bg-modalbg text-sm text-primary shadow-lg outline-none focus:border-accent/60"
        >
            <div className="flex items-center gap-1 border-b border-border px-2 py-1">
                <div className="min-w-0 flex-1 truncate font-semibold">{box.title ?? ""}</div>
                {box.actions.map((action, i) => (
                    <BoxActionButton key={i} action={action} />
                ))}
                <button
                    type="button"
                    title="Close (Escape)"
                    aria-label="Close"
                    className="cursor-pointer rounded px-1.5 py-0.5 text-secondary hover:bg-hover hover:text-primary"
                    onClick={() => host.dismissBox(box.id)}
                >
                    <i className="fa fa-solid fa-xmark" />
                </button>
            </div>
            <pre
                className={cn(
                    "m-0 max-h-60 overflow-auto px-2 py-1.5 break-words whitespace-pre-wrap select-text",
                    box.monospace ? "font-mono text-xs" : "font-sans"
                )}
            >
                {box.text}
            </pre>
        </div>
    );
}

function BoxStack({ host, boxes, anchor }: { host: MoltenHost; boxes: MoltenBoxEntry[]; anchor: Anchor }) {
    const style = anchor ?? { right: 16, bottom: 16, maxWidth: 460 };
    return (
        <div
            className="pointer-events-none fixed z-[9000] flex flex-col gap-2"
            style={{ right: style.right, bottom: style.bottom, width: style.maxWidth }}
        >
            {boxes.map((box) => (
                <MoltenBox key={box.id} host={host} box={box} />
            ))}
        </div>
    );
}

export function MoltenBoxes({ host }: { host: MoltenHost }) {
    const boxes = useAtomValue(host.boxesAtom, { store: globalStore });
    const [anchors, setAnchors] = useState<Record<string, Anchor>>({});
    const blockIds = [...new Set(boxes.map((b) => b.blockId).filter((id) => id != null))];
    const blockKey = blockIds.join(",");
    useEffect(() => {
        if (blockIds.length === 0) {
            return;
        }
        const missing: Record<string, number> = {};
        const update = () => {
            const next: Record<string, Anchor> = {};
            for (const blockId of blockIds) {
                const anchor = anchorFor(blockId);
                if (anchor != null) {
                    missing[blockId] = 0;
                    next[blockId] = anchor;
                    continue;
                }
                missing[blockId] = (missing[blockId] ?? 0) + 1;
                if (missing[blockId] >= MissingBlockPolls) {
                    globalStore
                        .get(host.boxesAtom)
                        .filter((b) => b.blockId === blockId)
                        .forEach((b) => host.dismissBox(b.id));
                }
            }
            setAnchors((prev) => {
                const keys = Object.keys(next);
                if (keys.length === Object.keys(prev).length && keys.every((k) => sameAnchor(prev[k], next[k]))) {
                    return prev;
                }
                return next;
            });
        };
        update();
        const timer = setInterval(update, PositionPollMs);
        window.addEventListener("resize", update);
        return () => {
            clearInterval(timer);
            window.removeEventListener("resize", update);
        };
    }, [blockKey, host]);
    if (boxes.length === 0) {
        return null;
    }
    const loose = boxes.filter((b) => b.blockId == null || anchors[b.blockId] == null);
    return (
        <>
            {blockIds
                .filter((blockId) => anchors[blockId] != null)
                .map((blockId) => (
                    <BoxStack
                        key={blockId}
                        host={host}
                        boxes={boxes.filter((b) => b.blockId === blockId)}
                        anchor={anchors[blockId]}
                    />
                ))}
            {loose.length > 0 ? <BoxStack host={host} boxes={loose} anchor={null} /> : null}
        </>
    );
}
