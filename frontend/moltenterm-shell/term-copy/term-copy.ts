// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Clean copy and file links on terminal blocks (FR-SHELL-017, DS-SHELL-018): the glue between xterm, the agent states
// (FR-SHELL-011), wavesrv's stat and the preview. The rules themselves are pure and live next to this file.

import { createBlockSplitHorizontally, getBlockComponentModel, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getActiveTabModel } from "@/app/store/tab-model";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TermWrap } from "@/app/view/term/termwrap";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { PLATFORM, PlatformMacOS } from "@/util/platformutil";
import { fireAndForget, isBlank, makeConnRoute } from "@/util/util";
import type { IBufferLine, IDisposable, ILink, Terminal } from "@xterm/xterm";
import { AgentStates } from "../agent-state-store";
import { agentCopyProfile, AgentCopyProfile, GenericCopyProfile } from "./agent-copy-profiles";
import { cleanCopy, CopyLine, CopySelection, textColumns } from "./clean-copy";
import { FileRef, findFileRefs, parseFileRef } from "./file-links";
import { FileStatCache } from "./file-stat-cache";

// Block meta the preview reads to reveal a line (preview-line.ts); the sequence re-reveals the same line.
export const PreviewLineMetaKey = "molten:line";
export const PreviewColMetaKey = "molten:col";
export const PreviewLineSeqMetaKey = "molten:lineseq";

const StatTimeoutMs = 3000;
const RenderedFileRegex = /\.(md|mdx|markdown|csv)$/i;
// A wrapped group longer than this is not scanned for links (a minified file dumped in the terminal).
const MaxLinkScanRows = 40;

export const fileStatCache = new FileStatCache(async (conn, cwd, paths) => {
    return await RpcApi.RemoteFileMultiInfoCommand(
        TabRpcClient,
        { cwd, paths },
        { route: makeConnRoute(conn), timeout: StatTimeoutMs }
    );
});

export type HoveredFileLink = { path: string; line?: number; col?: number; conn: string };

// The file link under the mouse per terminal, for the context menu's "Open File".
const hoveredFileLinks = new WeakMap<TermWrap, HoveredFileLink>();

export function getHoveredFileLink(termWrap: TermWrap): HoveredFileLink {
    return termWrap == null ? null : (hoveredFileLinks.get(termWrap) ?? null);
}

type BlockPlace = { conn: string; cwd: string };

function blockPlace(blockId: string): BlockPlace {
    const block = globalStore.get(getWaveObjectAtom<Block>(makeORef("block", blockId)));
    const conn = block?.meta?.connection ?? "";
    return { conn: conn === "local" ? "" : conn, cwd: block?.meta?.["cmd:cwd"] ?? "" };
}

// The agent running in the terminal: its state from wavesrv (FR-SHELL-011), else Claude Code seen by the shell
// integration.
export function termAgentId(termWrap: TermWrap): string {
    if (termWrap == null) {
        return "";
    }
    const info = globalStore.get(AgentStates.getInstance().blockAtom(termWrap.blockId));
    if (info?.agent) {
        return info.agent;
    }
    return globalStore.get(termWrap.claudeCodeActiveAtom) ? "claude" : "";
}

export function termCopyProfile(termWrap: TermWrap): AgentCopyProfile {
    return agentCopyProfile(termAgentId(termWrap));
}

function lineText(line: IBufferLine, trimRight: boolean, startCol?: number, endCol?: number): string {
    return line?.translateToString(trimRight, startCol, endCol) ?? "";
}

// The selected buffer lines as clean-copy.ts reads them; null without a selection (or with a block selection).
export function selectionCopyLines(terminal: Terminal): CopySelection {
    const pos = terminal?.getSelectionPosition();
    if (pos == null) {
        return null;
    }
    const buf = terminal.buffer.active;
    const lines: CopyLine[] = [];
    for (let y = pos.start.y; y <= pos.end.y; y++) {
        const line = buf.getLine(y);
        if (line == null) {
            continue;
        }
        const beforeSoftWrap = buf.getLine(y + 1)?.isWrapped && y < pos.end.y;
        const start = y === pos.start.y ? pos.start.x : 0;
        const end = y === pos.end.y ? pos.end.x : undefined;
        const text = lineText(line, !beforeSoftWrap, 0, end);
        const copyLine: CopyLine = { text, wrapped: line.isWrapped && y > pos.start.y };
        if (start > 0) {
            const before = lineText(line, false, 0, start);
            if (before.trim() !== "") {
                copyLine.text = lineText(line, !beforeSoftWrap, start, end);
                copyLine.midLine = true;
                copyLine.startCol = start;
            }
        }
        if (y === pos.start.y && line.isWrapped) {
            // The selection starts on the continuation of a wrapped line: its indentation is not the text's.
            copyLine.midLine = true;
            copyLine.startCol = start;
        }
        lines.push(copyLine);
    }
    return { lines, cols: terminal.cols };
}

export function cleanSelectionText(termWrap: TermWrap, profile?: AgentCopyProfile): string {
    const sel = selectionCopyLines(termWrap?.terminal);
    if (sel == null) {
        return "";
    }
    return cleanCopy(sel, profile ?? termCopyProfile(termWrap) ?? GenericCopyProfile);
}

// The text a plain copy gives: xterm's selection, trailing spaces trimmed as Wave does unless turned off.
export function plainSelectionText(termWrap: TermWrap): string {
    const text = termWrap?.terminal?.getSelection() ?? "";
    if (globalStore.get(getSettingsKeyAtom("term:trimtrailingwhitespace")) === false) {
        return text;
    }
    return text
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n");
}

// What Cmd+C and copy-on-select copy: clean in a terminal running a known agent, plain elsewhere.
export function defaultSelectionText(termWrap: TermWrap): string {
    if (termAgentId(termWrap) === "") {
        return null;
    }
    return cleanSelectionText(termWrap);
}

export function copyText(text: string): void {
    if (!text) {
        return;
    }
    fireAndForget(() => navigator.clipboard.writeText(text));
}

// Cmd+C reaches xterm as a copy event on its element; a listener on the way down replaces the text when an agent
// runs. Without an agent, xterm's own handler copies as before.
function installCopyHandler(termWrap: TermWrap): IDisposable {
    const elem = termWrap.connectElem;
    const handler = (e: ClipboardEvent) => {
        if (!termWrap.terminal.hasSelection()) {
            return;
        }
        const text = defaultSelectionText(termWrap);
        if (text == null || text === "") {
            return;
        }
        e.clipboardData?.setData("text/plain", text);
        e.preventDefault();
        e.stopImmediatePropagation();
    };
    elem.addEventListener("copy", handler, true);
    return { dispose: () => elem.removeEventListener("copy", handler, true) };
}

// The logical line (soft wraps joined) that contains buffer row `y` (0-based): its first row and its text.
function wrappedGroup(terminal: Terminal, y: number): { startRow: number; rows: number; text: string } {
    const buf = terminal.buffer.active;
    let start = y;
    while (start > 0 && buf.getLine(start)?.isWrapped && y - start < MaxLinkScanRows) {
        start--;
    }
    let end = y;
    while (buf.getLine(end + 1)?.isWrapped && end - start < MaxLinkScanRows) {
        end++;
    }
    let text = "";
    for (let r = start; r <= end; r++) {
        text += lineText(buf.getLine(r), r === end);
    }
    return { startRow: start, rows: end - start + 1, text };
}

function isOpenClick(e: MouseEvent): boolean {
    return PLATFORM === PlatformMacOS ? e.metaKey : e.ctrlKey;
}

function makeFileLink(
    termWrap: TermWrap,
    ref: FileRef,
    info: FileInfo,
    group: { startRow: number; text: string },
    conn: string
): ILink {
    const cols = termWrap.terminal.cols;
    const startCol = textColumns(group.text.slice(0, ref.start));
    const endCol = textColumns(group.text.slice(0, ref.end)) - 1;
    const target: HoveredFileLink = { path: info.path, line: info.isdir ? undefined : ref.line, col: ref.col, conn };
    return {
        range: {
            start: { x: (startCol % cols) + 1, y: group.startRow + Math.floor(startCol / cols) + 1 },
            end: { x: (endCol % cols) + 1, y: group.startRow + Math.floor(endCol / cols) + 1 },
        },
        text: group.text.slice(ref.start, ref.end),
        decorations: { pointerCursor: true, underline: true },
        activate: (e) => {
            if (!isOpenClick(e)) {
                return;
            }
            e.preventDefault();
            fireAndForget(() => openFileInPreview(target, termWrap.blockId));
        },
        hover: (e, text) => {
            hoveredFileLinks.set(termWrap, target);
            termWrap.onLinkHover?.(text, e.clientX, e.clientY);
        },
        leave: () => {
            hoveredFileLinks.delete(termWrap);
            termWrap.onLinkHover?.(null, 0, 0);
        },
    };
}

// Links on the references whose file exists, relative ones resolved against the pane's folder.
function installFileLinks(termWrap: TermWrap): IDisposable {
    const terminal = termWrap.terminal;
    return terminal.registerLinkProvider({
        provideLinks: (bufferLineNumber, callback) => {
            const y = bufferLineNumber - 1;
            const group = wrappedGroup(terminal, y);
            const cols = terminal.cols;
            const refs = findFileRefs(group.text).filter((ref) => {
                const first = Math.floor(textColumns(group.text.slice(0, ref.start)) / cols);
                const last = Math.floor((textColumns(group.text.slice(0, ref.end)) - 1) / cols);
                return group.startRow + first <= y && y <= group.startRow + last;
            });
            const place = blockPlace(termWrap.blockId);
            const usable = refs.filter((ref) => ref.path.startsWith("/") || ref.path.startsWith("~") || !isBlank(place.cwd));
            if (usable.length === 0) {
                callback(undefined);
                return;
            }
            fireAndForget(async () => {
                const infos = await Promise.all(usable.map((ref) => fileStatCache.stat(place.conn, place.cwd, ref.path)));
                const links: ILink[] = [];
                usable.forEach((ref, i) => {
                    if (infos[i] != null) {
                        links.push(makeFileLink(termWrap, ref, infos[i], group, place.conn));
                    }
                });
                callback(links.length > 0 ? links : undefined);
            });
        },
    });
}

export function installTermCopy(termWrap: TermWrap): IDisposable[] {
    return [installCopyHandler(termWrap), installFileLinks(termWrap)];
}

// The selection as a file of the pane, for the selection toolbar's Open; null when it names no existing file.
export async function statSelectionFile(termWrap: TermWrap, ref: FileRef): Promise<HoveredFileLink> {
    if (ref == null) {
        return null;
    }
    const place = blockPlace(termWrap.blockId);
    if (!ref.path.startsWith("/") && !ref.path.startsWith("~") && isBlank(place.cwd)) {
        return null;
    }
    const info = await fileStatCache.stat(place.conn, place.cwd, ref.path);
    if (info == null) {
        return null;
    }
    return { path: info.path, line: info.isdir ? undefined : ref.line, col: ref.col, conn: place.conn };
}

// Opens the file in a preview next to the terminal, at the line; a preview of the same file in the tab is reused.
export async function openFileInPreview(target: HoveredFileLink, fromBlockId: string): Promise<void> {
    const lineMeta: Record<string, unknown> = {
        [PreviewLineMetaKey]: target.line ?? null,
        [PreviewColMetaKey]: target.col ?? null,
        [PreviewLineSeqMetaKey]: Date.now(),
    };
    if (target.line != null && RenderedFileRegex.test(target.path)) {
        // Markdown and CSV render as documents; a line is only shown by the code editor.
        lineMeta.edit = true;
    }
    const tabAtom = getActiveTabModel()?.tabAtom;
    const tab = tabAtom == null ? null : globalStore.get(tabAtom);
    const layoutModel = getLayoutModelForStaticTab();
    for (const blockId of tab?.blockids ?? []) {
        const block = globalStore.get(getWaveObjectAtom<Block>(makeORef("block", blockId)));
        const meta = block?.meta;
        if (meta?.view !== "preview" || meta?.file !== target.path || (meta?.connection ?? "") !== target.conn) {
            continue;
        }
        const node = layoutModel?.getNodeByBlockId(blockId);
        if (node == null) {
            continue;
        }
        await RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("block", blockId), meta: lineMeta as MetaType });
        layoutModel.focusNode(node.id);
        return;
    }
    const meta: MetaType = { view: "preview", file: target.path, ...lineMeta } as MetaType;
    if (target.conn) {
        meta.connection = target.conn;
    }
    await createBlockSplitHorizontally({ meta }, fromBlockId, "after");
}

// The other terminals of the tab, for "Send to another pane".
export function otherTermBlocks(fromBlockId: string): { blockId: string; label: string }[] {
    const tabAtom = getActiveTabModel()?.tabAtom;
    const tab = tabAtom == null ? null : globalStore.get(tabAtom);
    const rtn: { blockId: string; label: string }[] = [];
    let n = 0;
    for (const blockId of tab?.blockids ?? []) {
        const block = globalStore.get(getWaveObjectAtom<Block>(makeORef("block", blockId)));
        if (block?.meta?.view !== "term") {
            continue;
        }
        n++;
        if (blockId === fromBlockId || getBlockComponentModel(blockId) == null) {
            continue;
        }
        const agent = globalStore.get(AgentStates.getInstance().blockAtom(blockId));
        const folder = (block.meta["cmd:cwd"] ?? "").split("/").filter((s: string) => s !== "").pop() ?? "";
        const name = agent?.agentname || agent?.agent || block.meta["frame:title"] || "Terminal";
        rtn.push({ blockId, label: folder ? `${name} · ${folder} (#${n})` : `${name} (#${n})` });
    }
    return rtn;
}

// Pastes into the other terminal (bracketed paste when its program asked for it) and focuses it.
export function sendTextToTerm(text: string, blockId: string): void {
    if (!text) {
        return;
    }
    const viewModel = getBlockComponentModel(blockId)?.viewModel as { termRef?: { current?: TermWrap } };
    const target = viewModel?.termRef?.current;
    if (target?.terminal == null) {
        return;
    }
    target.terminal.paste(text);
    const node = getLayoutModelForStaticTab()?.getNodeByBlockId(blockId);
    if (node != null) {
        getLayoutModelForStaticTab().focusNode(node.id);
    }
}

// The context menu's copy entries: Copy does what Cmd+C does; the other way is one entry away.
export function termCopyMenuItems(termWrap: TermWrap): ContextMenuItem[] {
    if (!termWrap?.terminal?.hasSelection()) {
        return [];
    }
    const clean = cleanSelectionText(termWrap);
    const plain = plainSelectionText(termWrap);
    const agent = termAgentId(termWrap) !== "";
    const items: ContextMenuItem[] = [
        { label: "Copy", click: () => copyText(agent ? clean : plain) },
        agent
            ? { label: "Copy Plain", click: () => copyText(plain) }
            : { label: "Copy Clean", click: () => copyText(clean) },
    ];
    const ref = parseFileRef(plain);
    const others = otherTermBlocks(termWrap.blockId);
    if (others.length > 0) {
        items.push({
            label: "Send to Pane",
            submenu: others.map((o) => ({ label: o.label, click: () => sendTextToTerm(clean, o.blockId) })),
        });
    }
    if (ref != null) {
        items.push({
            label: "Open File",
            click: () =>
                fireAndForget(async () => {
                    const target = await statSelectionFile(termWrap, ref);
                    if (target != null) {
                        await openFileInPreview(target, termWrap.blockId);
                    }
                }),
        });
    }
    return items;
}

export function termFileLinkMenuItems(termWrap: TermWrap): ContextMenuItem[] {
    const link = getHoveredFileLink(termWrap);
    if (link == null) {
        return [];
    }
    const name = link.path.split("/").pop() + (link.line ? `:${link.line}` : "");
    return [
        { label: `Open ${name}`, click: () => fireAndForget(() => openFileInPreview(link, termWrap.blockId)) },
        { type: "separator" },
    ];
}
