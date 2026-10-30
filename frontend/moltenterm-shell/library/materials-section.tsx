// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The library's Materials section, simple version (FR-MAT-002, DS-MAT-005): the current project's materials by day,
// pinned ones on top. A row is renamed in place, pinned, opened in a view of the workspace (or shown when already
// open), shown in its folder, its link copied, its copy deleted with Undo. The preview pane of mockup a is FR-MAT-004
// (#1428): until then the selected row carries its one orange button and its menu.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms, createBlock, getApi } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { useWaveObjectValue } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserActiveMetaKey, MoltentermBrowserView, readBrowserState } from "../browser/browser-model";
import { openInBrowserPanel } from "../browser/browser-routing";
import { t as tNow, useLocale, useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { MoltentermNotifications } from "../notifications-store";
import { SidebarModel } from "../sidebar/sidebar-store";
import { isProjectTab } from "../sidebar/view-pins-model";
import { ViewPins } from "../sidebar/view-pins-store";
import { useTabIdentity } from "../tab-identity-ui";
import { showToast } from "../toast-store";
import { libraryAddAsk, whenText } from "./library-model";
import {
    filterMaterials,
    findOpenPanel,
    groupMaterials,
    linkHost,
    Material,
    materialAt,
    materialCopied,
    MaterialCopyCommand,
    MaterialDeleteCopyCommand,
    materialFolderPath,
    materialForm,
    materialKeepOffer,
    MaterialKindDocument,
    MaterialKindPage,
    materialLinkedFiles,
    MaterialOpen,
    materialOpenPlan,
    materialOriginKey,
    MaterialPinCommand,
    MaterialRenameCommand,
    MaterialRestoreCommand,
    MaterialsChanged,
    MaterialsEvent,
    materialSizeText,
    MaterialsListCommand,
    MaterialsNoProject,
    MaterialsRoute,
    materialsSeenStorageKey,
    MaterialsView,
    MaterialUndoMs,
    materialVersion,
    newMaterialsCount,
    OpenPanel,
    renamedTitle,
} from "./materials-model";

const CallTimeoutMs = 5000;
const PreviewView = "preview";

function callMaterials<T>(command: string, data: Record<string, any>): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: MaterialsRoute, timeout: CallTimeoutMs });
}

function closeLibrary() {
    SidebarModel.getInstance().closeLibrary();
}

function parentFolder(path: string): string {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return i > 0 ? path.slice(0, i) : path;
}

function showInFolder(path: string) {
    if (!path) {
        return;
    }
    getApi().openNativePath(parentFolder(path));
}

async function copyText(text: string, doneKey: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        showToast({ kind: "success", title: tNow(doneKey) });
    } catch (e) {
        showToast({ kind: "error", title: tNow("library.materials.copyFailed"), message: String(e) });
    }
}

// ---------- The drawer ----------

// The drawer of the workspace the developer is in, kept current by the registry's event (scoped to the drawer).
export function useMaterialsDrawer(workspaceId: string): { view: MaterialsView; failed: boolean } {
    const [view, setView] = useState<MaterialsView>(null);
    const [failed, setFailed] = useState(false);
    const key = view?.project?.key ?? "";
    const loadRef = useRef<() => void>(null);
    useEffect(() => {
        let cancelled = false;
        const load = () =>
            fireAndForget(async () => {
                try {
                    const next = await callMaterials<MaterialsView>(MaterialsListCommand, {
                        workspaceid: workspaceId,
                    });
                    if (!cancelled) {
                        setView(next ?? null);
                        setFailed(false);
                    }
                } catch (e) {
                    console.log("library: materials", e);
                    if (!cancelled) {
                        setFailed(true);
                    }
                }
            });
        loadRef.current = load;
        load();
        return () => {
            cancelled = true;
        };
    }, [workspaceId]);
    useEffect(() => {
        if (!key) {
            return;
        }
        try {
            return waveEventSubscribeSingle({
                eventType: MaterialsEvent as WaveEventName,
                scope: key,
                handler: (event) => {
                    const data = event.data as MaterialsChanged;
                    if (data?.project && data.project !== key) {
                        return;
                    }
                    loadRef.current?.();
                },
            });
        } catch (e) {
            console.log("library: materials, no event bus", e);
        }
    }, [key]);
    return { view, failed };
}

function readSeen(project: string): number {
    try {
        return Number(window.localStorage.getItem(materialsSeenStorageKey(project))) || 0;
    } catch {
        return 0;
    }
}

function writeSeen(project: string, at: number) {
    try {
        window.localStorage.setItem(materialsSeenStorageKey(project), String(at));
    } catch {
        // A refused storage only loses the count's memory.
    }
}

// The grey count on the section's entry (AC12): it goes when the section opens, and what is seen while it is open
// stays seen.
export function useMaterialsNewCount(view: MaterialsView, open: boolean): number {
    const project = view?.project?.key ?? "";
    const [seen, setSeen] = useState<number>(() => readSeen(project));
    useEffect(() => {
        setSeen(readSeen(project));
    }, [project]);
    useEffect(() => {
        if (!open || view == null) {
            return;
        }
        const mark = () => {
            const now = Date.now();
            writeSeen(project, now);
            setSeen(now);
        };
        mark();
        return mark;
    }, [open, project, view]);
    return open ? 0 : newMaterialsCount(view?.materials, seen);
}

// ---------- Where a material is open ----------

type ShownPanel = OpenPanel;

// The panels of the workspace's views that show a page or a file, as the store has them.
function useOpenPanels(workspaceId: string): ShownPanel[] {
    const panelsAtom = useMemo(
        () =>
            atom((get) => {
                const ws = get(WOS.getWaveObjectAtom<Workspace>(WOS.makeORef("workspace", workspaceId)));
                const rtn: ShownPanel[] = [];
                for (const tabId of ws?.tabids ?? []) {
                    const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
                    for (const blockId of tab?.blockids ?? []) {
                        const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
                        const view = block?.meta?.view;
                        if (view === MoltentermBrowserView) {
                            const tabs = readBrowserState(
                                block.meta as Record<string, any>,
                                block.meta?.url ?? ""
                            ).tabs;
                            rtn.push({
                                blockId,
                                tabId,
                                view,
                                urls: tabs.map((b) => b.url),
                            });
                        } else if (view === PreviewView && block.meta?.file) {
                            rtn.push({ blockId, tabId, view, file: block.meta.file });
                        }
                    }
                }
                return rtn;
            }),
        [workspaceId]
    );
    return useAtomValue(panelsAtom);
}

function browserTabOf(panel: ShownPanel, link: string): string {
    if (panel.view !== MoltentermBrowserView || !link) {
        return null;
    }
    const block = WOS.getObjectValue<Block>(WOS.makeORef("block", panel.blockId));
    const clean = (u: string) => (u ?? "").replace(/#.*$/, "").replace(/\/+$/, "");
    return (
        readBrowserState(block?.meta as Record<string, any>, "").tabs.find((b) => clean(b.url) === clean(link))?.id ??
        null
    );
}

async function showPanel(workspaceId: string, panel: ShownPanel, link: string): Promise<void> {
    closeLibrary();
    const browserTabId = browserTabOf(panel, link);
    if (browserTabId) {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", panel.blockId),
            meta: { [BrowserActiveMetaKey]: browserTabId } as MetaType,
        });
    }
    await MoltentermNotifications.getInstance().goTo({
        workspaceid: workspaceId,
        tabid: panel.tabId,
        blockid: panel.blockId,
    });
}

function blockDefOf(plan: MaterialOpen): BlockDef {
    if (plan?.how === "browser") {
        return { meta: { view: MoltentermBrowserView, url: plan.url } as MetaType };
    }
    if (plan?.how === "preview") {
        return { meta: { view: PreviewView, file: plan.path } as MetaType };
    }
    return null;
}

// In the view the developer is in: after its panels, so to the right of the agent (DS-REV-012); nothing moves.
async function openHere(plan: MaterialOpen): Promise<void> {
    closeLibrary();
    if (plan.how === "browser") {
        await openInBrowserPanel(plan.url);
        return;
    }
    await createBlock(blockDefOf(plan));
}

function openInNewView(plan: MaterialOpen) {
    closeLibrary();
    getApi().createTab(blockDefOf(plan));
}

// Opens at once what opens outside a view: a document in its application, a page without its online version in its
// folder. True when done.
function openOutsideView(plan: MaterialOpen): boolean {
    if (plan?.how === "native") {
        getApi().openNativePath(plan.path);
        return true;
    }
    if (plan?.how === "folder") {
        showInFolder(plan.path);
        return true;
    }
    return false;
}

// ---------- Actions ----------

async function renameMaterial(m: Material, title: string): Promise<void> {
    try {
        await callMaterials(MaterialRenameCommand, { project: m.project, id: m.id, title: renamedTitle(title) });
    } catch (e) {
        showToast({ kind: "error", title: tNow("library.materials.renameFailed"), message: String(e?.message ?? e) });
    }
}

async function pinMaterial(m: Material, pinned: boolean): Promise<void> {
    try {
        await callMaterials(MaterialPinCommand, { project: m.project, id: m.id, pinned });
    } catch (e) {
        showToast({ kind: "error", title: tNow("library.materials.pinFailed"), message: String(e?.message ?? e) });
    }
}

async function keepCopy(m: Material, anyway: boolean): Promise<void> {
    try {
        await callMaterials(MaterialCopyCommand, {
            project: m.project,
            id: m.id,
            requested: true,
            allowsecret: anyway,
        });
        showToast({ kind: "success", title: tNow("library.materials.kept") });
    } catch (e) {
        showToast({ kind: "error", title: tNow("library.materials.keepFailed"), message: String(e?.message ?? e) });
    }
}

// Delete removes the copy only (AC11): to the materials trash, with Undo for 10 seconds.
async function deleteCopy(m: Material): Promise<void> {
    let trashId: string;
    try {
        trashId = (
            await callMaterials<{ trashid: string }>(MaterialDeleteCopyCommand, {
                project: m.project,
                id: m.id,
            })
        )?.trashid;
    } catch (e) {
        showToast({ kind: "error", title: tNow("library.materials.deleteFailed"), message: String(e?.message ?? e) });
        return;
    }
    if (!trashId) {
        return;
    }
    const title = m.title;
    showToast({
        kind: "info",
        title: tNow("library.materials.deleted", { title }),
        message: tNow("library.materials.deletedSub"),
        text: () => ({
            title: tNow("library.materials.deleted", { title }),
            message: tNow("library.materials.deletedSub"),
            actionLabels: { undo: tNow("library.materials.undo") },
        }),
        dismissMs: MaterialUndoMs,
        actions: [
            {
                id: "undo",
                label: tNow("library.materials.undo"),
                run: async () => {
                    try {
                        await callMaterials(MaterialRestoreCommand, { project: m.project, trashid: trashId });
                    } catch (e) {
                        showToast({
                            kind: "error",
                            title: tNow("library.materials.undoFailed"),
                            message: String(e?.message ?? e),
                        });
                    }
                },
            },
        ],
    });
}

type RowHandlers = {
    onRename: (m: Material) => void;
    onOpen: (m: Material, plan: MaterialOpen) => void;
    onDelete: (m: Material) => void;
};

// The row menu ("..." and the right click, AC10, mockup b).
function showMaterialMenu(e: React.MouseEvent, m: Material, handlers: RowHandlers, locale: string) {
    const copied = materialCopied(m);
    const folder = materialFolderPath(m);
    const keep = materialKeepOffer(m);
    const copyPlan: MaterialOpen =
        copied && m.copypath && m.kind !== MaterialKindPage
            ? m.kind === MaterialKindDocument
                ? { how: "native", path: m.copypath }
                : { how: "preview", path: m.copypath }
            : null;
    const items: ContextMenuItem[] = [
        { label: tNow("library.materials.menu.rename"), accelerator: "F2", click: () => handlers.onRename(m) },
        {
            label: tNow(m.pinned ? "library.materials.menu.unpin" : "library.materials.menu.pin"),
            click: () => fireAndForget(() => pinMaterial(m, !m.pinned)),
        },
        { type: "separator" },
        {
            label: tNow("library.materials.menu.openOnline"),
            visible: !!m.link,
            click: () => handlers.onOpen(m, { how: "browser", url: m.link }),
        },
        {
            label: tNow("library.materials.menu.openCopy"),
            visible: copyPlan != null,
            click: () => handlers.onOpen(m, copyPlan),
        },
        {
            label: tNow("library.materials.menu.showInFolder"),
            visible: !!folder,
            click: () => showInFolder(folder),
        },
        {
            label: tNow("library.materials.menu.copyLink"),
            visible: !!m.link,
            click: () => fireAndForget(() => copyText(m.link, "library.materials.linkCopied")),
        },
        {
            label: tNow("library.materials.menu.copyPath"),
            visible: copied && !!m.copypath,
            click: () => fireAndForget(() => copyText(m.copypath, "library.materials.pathCopied")),
        },
        {
            label:
                keep === "keepanyway"
                    ? tNow("library.materials.menu.keepAnyway")
                    : tNow("library.materials.menu.keepCopy", { size: materialSizeText(m.size, locale) || "?" }),
            visible: keep != null,
            click: () => fireAndForget(() => keepCopy(m, keep === "keepanyway")),
        },
        { type: "separator" },
        { label: tNow("library.materials.menu.delete"), destructive: true, click: () => handlers.onDelete(m) },
    ];
    ContextMenuModel.getInstance().showContextMenu(items, e);
}

// ---------- Rows ----------

const KindIcons: Record<string, string> = {
    page: "file-lines",
    link: "link",
    pdf: "file-pdf",
    image: "image",
    video: "film",
    text: "file-lines",
    document: "file",
};

function RenameField({ m, onDone }: { m: Material; onDone: () => void }) {
    const t = useT();
    const [value, setValue] = useState(m.title ?? "");
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);
    const original = m.originalname || m.autotitle || "";
    return (
        <div className="min-w-0 flex-1" data-lib-escape="local">
            <input
                ref={ref}
                className="mt-lib-mat-rename"
                value={value}
                aria-label={t("library.materials.renameLabel")}
                data-testid="library-material-rename"
                onChange={(e) => setValue(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") {
                        e.preventDefault();
                        onDone();
                        return;
                    }
                    if (e.key === "Enter") {
                        e.preventDefault();
                        const next = renamedTitle(value);
                        onDone();
                        if (next !== (m.title ?? "")) {
                            fireAndForget(() => renameMaterial(m, next));
                        }
                    }
                }}
                onBlur={onDone}
            />
            <div className="mt-lib-mat-was">
                {original
                    ? t("library.materials.renameHintWas", { name: original })
                    : t("library.materials.renameHint")}
            </div>
        </div>
    );
}

// "Open in 'Cadrage'" (AC8): the view's name as the sidebar shows it.
function OpenInPill({ tabId }: { tabId: string }) {
    const t = useT();
    const [tab] = useWaveObjectValue<Tab>(WOS.makeORef("tab", tabId));
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    const name = identity.name || t("library.panels.thisView");
    return (
        <span className="mt-lib-mat-form is-live" data-testid="library-material-open-in">
            {t("library.materials.openIn", { view: name })}
        </span>
    );
}

function MaterialFacts({ m, timeOnly }: { m: Material; timeOnly: boolean }) {
    const t = useT();
    const tc = useTCount();
    const locale = useLocale();
    const version = materialVersion(m);
    const files = materialLinkedFiles(m);
    const originKey = materialOriginKey(m);
    const at = materialAt(m);
    const time = timeOnly
        ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(at))
        : whenText(at, Date.now(), locale);
    const who = originKey ? t(`library.materials.origin.${originKey}`, { agent: m.agent ?? "" }) : (m.agent ?? "");
    const parts: React.ReactNode[] = [
        t(`library.materials.kind.${m.kind}`),
        version > 1 ? t("library.materials.version", { n: version }) : null,
        m.kind === "video" || m.kind === "document" ? materialSizeText(m.size, locale) : null,
        who || null,
        m.ticket ? (
            <span key="tk" className="mt-lib-tk">
                #{m.ticket}
            </span>
        ) : null,
        at ? time : null,
        files > 0 ? tc("library.materials.linkedFiles", files) : null,
    ].filter((p) => p != null && p !== "");
    return (
        <span>
            {parts.map((p, i) => (
                <span key={i}>
                    {i > 0 ? " · " : ""}
                    {p}
                </span>
            ))}
        </span>
    );
}

function MaterialRow({
    m,
    timeOnly,
    selected,
    renaming,
    open,
    handlers,
    onSelect,
    onRenameDone,
    asked,
}: {
    m: Material;
    timeOnly: boolean;
    selected: boolean;
    renaming: boolean;
    open: ShownPanel;
    handlers: RowHandlers;
    onSelect: () => void;
    onRenameDone: () => void;
    // A question is open under the row: its own buttons answer, the row's orange one steps aside.
    asked: boolean;
}) {
    const t = useT();
    const locale = useLocale();
    const form = materialForm(m);
    const plan = materialOpenPlan(m);
    const formText =
        form.warn && m.size
            ? `${t(`library.materials.form.${form.key}`)} · ${materialSizeText(m.size, locale)}`
            : t(`library.materials.form.${form.key}`);
    const primary = open
        ? t("library.materials.showIt")
        : plan?.how === "folder"
          ? t("library.materials.menu.showInFolder")
          : t("library.materials.openInView");
    return (
        <div
            role="option"
            tabIndex={selected ? 0 : -1}
            aria-selected={selected}
            className={cn("mt-lib-mat", selected && "is-sel")}
            title={m.link || m.copypath || m.original || m.title}
            data-testid="library-material"
            data-material-id={m.id}
            onClick={onSelect}
            onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest?.(".mt-lib-mat-title")) {
                    handlers.onRename(m);
                    return;
                }
                if (plan != null) {
                    handlers.onOpen(m, plan);
                }
            }}
            onContextMenu={(e) => {
                onSelect();
                showMaterialMenu(e, m, handlers, locale);
            }}
        >
            <span className="mt-lib-mat-th" aria-hidden>
                <i className={makeIconClass(KindIcons[m.kind] ?? "file", true)} />
            </span>
            {renaming ? (
                <RenameField m={m} onDone={onRenameDone} />
            ) : (
                <span className="mt-lib-mat-tx">
                    <b className="mt-lib-mat-title">{m.title || linkHost(m.link) || m.id}</b>
                    <MaterialFacts m={m} timeOnly={timeOnly} />
                </span>
            )}
            {m.pinned ? (
                <i
                    className={cn(makeIconClass("thumbtack", true), "mt-lib-mat-pin")}
                    title={t("library.materials.pinned")}
                    aria-label={t("library.materials.pinned")}
                />
            ) : null}
            {open ? (
                <OpenInPill tabId={open.tabId} />
            ) : (
                <span className={cn("mt-lib-mat-form", form.warn && "is-warn")} data-testid="library-material-form">
                    {form.key === "linkCopy" ? <i className={makeIconClass("cloud", true)} aria-hidden /> : null}
                    {formText}
                </span>
            )}
            {!renaming && !asked && (open != null || plan != null) ? (
                <button
                    type="button"
                    className="mt-lib-mat-go molten-btn cursor-pointer rounded-4 px-2.5 py-1 text-12"
                    tabIndex={selected ? 0 : -1}
                    data-testid="library-material-open"
                    onClick={(e) => {
                        e.stopPropagation();
                        handlers.onOpen(m, plan);
                    }}
                >
                    {primary}
                    <MoltenWave />
                </button>
            ) : null}
            {!renaming ? (
                <button
                    type="button"
                    className="mt-lib-mat-more"
                    title={t("library.materials.actions")}
                    aria-label={t("library.materials.actions")}
                    tabIndex={selected ? 0 : -1}
                    data-testid="library-material-more"
                    onClick={(e) => {
                        e.stopPropagation();
                        onSelect();
                        showMaterialMenu(e, m, handlers, locale);
                    }}
                >
                    <i className={makeIconClass("ellipsis", true)} aria-hidden />
                </button>
            ) : null}
        </div>
    );
}

// Open in a view asks where, like Panels (AC7): the view the developer is in, or a new one; a pinned view says first
// that the panel will change it (FR-SHELL-094).
function WhereAsk({ plan, onCancel }: { plan: MaterialOpen; onCancel: () => void }) {
    const t = useT();
    const tabId = useAtomValue(atoms.staticTabId);
    const [tab] = useWaveObjectValue<Tab>(WOS.makeORef("tab", tabId));
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    const viewState = useAtomValue(ViewPins.getInstance().stateAtom(tabId));
    const viewName = identity.name || t("library.panels.thisView");
    const askKey = libraryAddAsk(viewState, isProjectTab(tab));
    const firstRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        firstRef.current?.focus();
    }, []);
    return (
        <div
            className="mt-lib-mat-ask"
            role="group"
            data-lib-escape="local"
            data-testid="library-material-ask"
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancel();
                }
            }}
        >
            <div className="text-11 text-secondary">
                {askKey ? t(askKey, { view: viewName }) : t("library.materials.where")}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
                <button
                    ref={firstRef}
                    type="button"
                    className="mt-lib-btn"
                    data-testid="library-material-ask-here"
                    onClick={() => fireAndForget(() => openHere(plan))}
                >
                    {t("library.materials.inView", { view: viewName })}
                </button>
                <button
                    type="button"
                    className="mt-lib-btn"
                    data-testid="library-material-ask-newview"
                    onClick={() => openInNewView(plan)}
                >
                    {t("library.panels.inNewView")}
                </button>
                <button type="button" className="mt-lib-link" onClick={onCancel}>
                    {t("common.cancel")}
                </button>
            </div>
        </div>
    );
}

function DeleteAsk({ m, onCancel, onConfirm }: { m: Material; onCancel: () => void; onConfirm: () => void }) {
    const t = useT();
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);
    return (
        <div
            className="mt-lib-mat-ask"
            role="alertdialog"
            aria-label={t("library.materials.deleteTitle", { title: m.title })}
            data-lib-escape="local"
            data-testid="library-material-delete"
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancel();
                }
            }}
        >
            <div className="text-12 text-primary">{t("library.materials.deleteTitle", { title: m.title })}</div>
            <div className="text-11 text-secondary">{t("library.materials.deleteText")}</div>
            <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" className="mt-lib-link" onClick={onCancel}>
                    {t("common.cancel")}
                </button>
                <button
                    ref={ref}
                    type="button"
                    className="molten-btn cursor-pointer rounded-4 px-2.5 py-1 text-12"
                    data-testid="library-material-delete-confirm"
                    onClick={onConfirm}
                >
                    {t("library.materials.deleteCopy")}
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}

export function MaterialsSection({ view, failed, query }: { view: MaterialsView; failed: boolean; query: string }) {
    const t = useT();
    const locale = useLocale();
    const workspaceId = useAtomValue(atoms.workspaceId);
    const panels = useOpenPanels(workspaceId);
    const [selected, setSelected] = useState<string>(null);
    const [renaming, setRenaming] = useState<string>(null);
    const [asking, setAsking] = useState<{ id: string; plan: MaterialOpen }>(null);
    const [deleting, setDeleting] = useState<string>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const shown = useMemo(() => filterMaterials(view?.materials, query), [view, query]);
    const groups = useMemo(() => groupMaterials(shown, Date.now(), locale), [shown, locale]);
    const order = groups.flatMap((g) => g.items);
    // The first row stands selected until the developer picks another.
    const current = order.find((m) => m.id === selected) ?? order[0] ?? null;
    if (failed && view == null) {
        return (
            <div className="mt-lib-empty" data-testid="library-materials-failed">
                <b>{t("library.materials.failedTitle")}</b>
                <span>{t("library.materials.failed")}</span>
            </div>
        );
    }
    if (view == null) {
        return null;
    }
    const noProject = view.project?.key === MaterialsNoProject;
    const projectName = noProject ? t("library.materials.noProject") : view.project?.name || view.project?.key;
    const focusRow = (id: string) =>
        requestAnimationFrame(() =>
            listRef.current?.querySelector<HTMLElement>(`[data-material-id="${CSS.escape(id)}"]`)?.focus()
        );
    const handlers: RowHandlers = {
        onRename: (m) => {
            setAsking(null);
            setDeleting(null);
            setSelected(m.id);
            setRenaming(m.id);
        },
        onOpen: (m, plan) => {
            setDeleting(null);
            const open = findOpenPanel(panels, m) as ShownPanel;
            if (open != null && (plan == null || plan.how === materialOpenPlan(m)?.how)) {
                fireAndForget(() => showPanel(workspaceId, open, m.link));
                return;
            }
            if (plan == null || openOutsideView(plan)) {
                return;
            }
            setSelected(m.id);
            setAsking({ id: m.id, plan });
        },
        onDelete: (m) => {
            setAsking(null);
            setSelected(m.id);
            setDeleting(m.id);
        },
    };
    const onListKey = (e: React.KeyboardEvent) => {
        if (renaming != null || (e.target as HTMLElement).closest?.("[data-lib-escape]")) {
            return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (order.length === 0) {
                return;
            }
            const i = order.findIndex((m) => m.id === current?.id);
            const next = order[Math.min(order.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
            setSelected(next.id);
            focusRow(next.id);
            return;
        }
        if (current == null) {
            return;
        }
        if (e.key === "F2") {
            e.preventDefault();
            handlers.onRename(current);
            return;
        }
        if (e.key === "Enter" && (e.target as HTMLElement).getAttribute?.("role") === "option") {
            e.preventDefault();
            handlers.onOpen(current, materialOpenPlan(current));
        }
    };
    return (
        <div className="flex flex-col gap-2" data-testid="library-materials" data-project={view.project?.key}>
            <div className="mt-lib-mat-scope" data-testid="library-materials-scope">
                {noProject ? projectName : t("library.materials.thisProject", { name: projectName })}
            </div>
            {shown.length === 0 ? (
                <div className="mt-lib-empty" data-testid="library-materials-empty">
                    <b>
                        {t(
                            (view.materials?.length ?? 0) === 0
                                ? "library.materials.emptyTitle"
                                : "library.nothingFound"
                        )}
                    </b>
                    {(view.materials?.length ?? 0) === 0 ? <span>{t("library.materials.empty")}</span> : null}
                </div>
            ) : (
                <div
                    ref={listRef}
                    className="flex flex-col gap-0.5"
                    role="listbox"
                    aria-label={t("library.sections.materials.title")}
                    onKeyDown={onListKey}
                >
                    {groups.map((g) => (
                        <div
                            key={g.key}
                            role="group"
                            aria-label={g.labelKey ? t(`library.materials.day.${g.labelKey}`) : g.label}
                        >
                            <div className="mt-lib-day">
                                {g.labelKey ? t(`library.materials.day.${g.labelKey}`) : g.label}
                            </div>
                            {g.items.map((m) => (
                                <div key={m.id} className="flex flex-col">
                                    <MaterialRow
                                        m={m}
                                        timeOnly={g.timeOnly}
                                        selected={m.id === current?.id}
                                        renaming={renaming === m.id}
                                        asked={asking?.id === m.id || deleting === m.id}
                                        open={findOpenPanel(panels, m) as ShownPanel}
                                        handlers={handlers}
                                        onSelect={() => setSelected(m.id)}
                                        onRenameDone={() => {
                                            setRenaming(null);
                                            focusRow(m.id);
                                        }}
                                    />
                                    {asking?.id === m.id ? (
                                        <WhereAsk
                                            plan={asking.plan}
                                            onCancel={() => {
                                                setAsking(null);
                                                focusRow(m.id);
                                            }}
                                        />
                                    ) : null}
                                    {deleting === m.id ? (
                                        <DeleteAsk
                                            m={m}
                                            onCancel={() => {
                                                setDeleting(null);
                                                focusRow(m.id);
                                            }}
                                            onConfirm={() => {
                                                setDeleting(null);
                                                fireAndForget(() => deleteCopy(m));
                                            }}
                                        />
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
