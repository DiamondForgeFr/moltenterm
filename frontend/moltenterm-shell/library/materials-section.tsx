// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The library's Materials section, simple version (FR-MAT-002, DS-MAT-005): the current project's materials by day,
// pinned ones on top. A row is renamed in place, pinned, opened in a view of the workspace (or shown when already
// open), shown in its folder, its link copied, its copy deleted with Undo. The preview pane of mockup a is FR-MAT-004
// (#1428): until then the selected row carries its one orange button and its menu. A wide section shows cards instead
// of rows (#1546, DS-MAT-010): a visual, the kind, where the material lives, its origin and its state.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms, createBlock, getApi } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { useWaveObjectValue } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getWebServerEndpoint } from "@/util/endpoints";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BrowserActiveMetaKey, MoltentermBrowserView, readBrowserState } from "../browser/browser-model";
import { openInBrowserPanel } from "../browser/browser-routing";
import { TFunction, t as tNow, useLocale, useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { MoltentermNotifications } from "../notifications-store";
import { SidebarModel } from "../sidebar/sidebar-store";
import { isProjectTab } from "../sidebar/view-pins-model";
import { ViewPins } from "../sidebar/view-pins-store";
import { DominoLoader } from "../suite/suite";
import { useTabIdentity } from "../tab-identity-ui";
import { showToast } from "../toast-store";
import { workspaceShownName } from "../workspace-default-name";
import { logoUrl, pathBaseName, readWorkspaceProject } from "../workspace-project";
import { readProjectFacts } from "../workspace-project-store";
import { libraryAddAsk, whenText } from "./library-model";
import { LibraryPrefs } from "./library-prefs";
import {
    ActiveScope,
    CardRect,
    filterMaterials,
    findOpenPanel,
    GridMove,
    gridNeighbor,
    groupMaterials,
    linkHost,
    Material,
    materialAt,
    materialCopied,
    MaterialCopyCommand,
    MaterialDeleteCopyCommand,
    materialDisplayTitle,
    materialFolderPath,
    materialForm,
    MaterialForm,
    materialKeepOffer,
    MaterialKindDocument,
    MaterialKindPage,
    materialLargeVisual,
    materialLinkedFiles,
    MaterialOpen,
    MaterialOpenedCommand,
    materialOpenPlan,
    materialOriginKey,
    MaterialPinCommand,
    MaterialPlace,
    materialPlaceText,
    materialProjectName,
    MaterialRenameCommand,
    MaterialRestoreCommand,
    MaterialsCardsMinWidth,
    MaterialsDetailMinWidth,
    materialsInScope,
    materialSizeText,
    MaterialsNoProject,
    materialsProjectName,
    MaterialsRecoverCommand,
    MaterialsRecovered,
    MaterialsRecoverTimeoutMs,
    MaterialsRoute,
    MaterialsScope,
    materialStateChip,
    MaterialsView,
    materialTitleIsHost,
    MaterialUndoMs,
    materialVersion,
    materialVisual,
    newMaterialsCount,
    OpenPanel,
    otherProjects,
    recoveredParts,
    renamedTitle,
    ScopeProject,
    validScope,
} from "./materials-model";
import { useMaterialsAllProjects } from "./use-materials-all";

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
export { useMaterialsDrawer } from "./use-materials-drawer";

// The grey count on the section's entry (AC12): it goes when the section opens, and what is seen while it is open
// stays seen. When it was last seen is a setting (library-prefs.ts), the same in every view and after a restart.
export function useMaterialsNewCount(view: MaterialsView, open: boolean): number {
    const project = view?.project?.key ?? "";
    const prefs = LibraryPrefs.getInstance();
    const seenAll = useAtomValue(prefs.seenAtom);
    const seen = seenAll[project] ?? 0;
    useEffect(() => {
        if (!open || view == null) {
            return;
        }
        const mark = () => {
            prefs.markSeen(project, Date.now(), newMaterialsCount(view.materials, prefs.seenAt(project)) > 0);
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

// Places already told to the registry in this window: the section reports what it sees each time it shows.
const toldPlaces = new Set<string>();

function samePlace(a: MaterialPlace, b: MaterialPlace): boolean {
    return (
        a != null &&
        b != null &&
        a.workspaceid === b.workspaceid &&
        a.tabid === b.tabid &&
        (a.workspace ?? "") === (b.workspace ?? "") &&
        (a.view ?? "") === (b.view ?? "")
    );
}

// The registry remembers the last view a material was open in, so a card can say where it lived once it is closed.
function recordPlace(m: Material, place: MaterialPlace) {
    if (m == null || !place?.workspaceid || !place.tabid || !place.view || samePlace(m.lastopened, place)) {
        return;
    }
    const key = [m.project, m.id, place.workspaceid, place.tabid, place.workspace, place.view].join("\u0000");
    if (toldPlaces.has(key)) {
        return;
    }
    toldPlaces.add(key);
    fireAndForget(async () => {
        try {
            await callMaterials(MaterialOpenedCommand, { project: m.project, id: m.id, place });
        } catch (e) {
            toldPlaces.delete(key);
            console.log("library: material place", e);
        }
    });
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

// ---------- Search past sessions (FR-MAT-008) ----------

type RecoverState = { running: boolean; result?: MaterialsRecovered; failed?: string };

// Runs only on the developer's click; the registry's event refreshes the list as materials arrive. Nothing opens.
function useRecover(workspaceId: string): [RecoverState, () => void, () => void] {
    const [state, setState] = useState<RecoverState>({ running: false });
    const runningRef = useRef(false);
    useEffect(() => {
        setState({ running: false });
    }, [workspaceId]);
    const run = () => {
        if (runningRef.current || !workspaceId) {
            return;
        }
        runningRef.current = true;
        setState({ running: true });
        fireAndForget(async () => {
            try {
                const result = await TabRpcClient.wshRpcCall(
                    MaterialsRecoverCommand,
                    { workspaceid: workspaceId },
                    { route: MaterialsRoute, timeout: MaterialsRecoverTimeoutMs }
                );
                setState({ running: false, result: result as MaterialsRecovered });
            } catch (e) {
                setState({ running: false, failed: String(e?.message ?? e) });
            } finally {
                runningRef.current = false;
            }
        });
    };
    return [state, run, () => setState({ running: false })];
}

function RecoverStatus({ state, onDismiss }: { state: RecoverState; onDismiss: () => void }) {
    const t = useT();
    const tc = useTCount();
    if (!state.running && state.result == null && state.failed == null) {
        return null;
    }
    let text: string;
    if (state.running) {
        text = t("library.materials.recover.running");
    } else if (state.failed != null) {
        text = t("library.materials.recover.failed");
    } else {
        text = recoveredParts(state.result)
            .map((p) => (p.count != null ? tc(p.key, p.count) : t(p.key)))
            .join(", ");
    }
    return (
        <div
            className="mt-lib-mat-recover"
            role="status"
            title={state.failed ?? undefined}
            data-testid="library-materials-recover-status"
            data-state={state.running ? "running" : state.failed != null ? "failed" : "done"}
        >
            {state.running ? <DominoLoader /> : null}
            <span className="min-w-0 flex-1">{text}</span>
            {!state.running ? (
                <button type="button" className="mt-lib-link" onClick={onDismiss}>
                    {t("library.materials.recover.dismiss")}
                </button>
            ) : null}
        </div>
    );
}

function showSectionMenu(e: React.MouseEvent, running: boolean, onRecover: () => void) {
    const items: ContextMenuItem[] = [
        { label: tNow("library.materials.recover.button"), enabled: !running, click: onRecover },
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

// The view a material is open in, named as the sidebar names it, told to the registry as its last place.
function useLivePlace(m: Material, tabId: string): { workspace: string; view: string } {
    const workspace = useAtomValue(atoms.workspace);
    const [tab] = useWaveObjectValue<Tab>(WOS.makeORef("tab", tabId));
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    const view = identity.name ?? "";
    const wsId = workspace?.oid ?? "";
    const wsName = workspace?.name ?? "";
    useEffect(() => {
        if (!tab || !view || !wsId) {
            return;
        }
        recordPlace(m, { workspaceid: wsId, workspace: wsName, tabid: tabId, view });
    }, [m, tab, tabId, view, wsId, wsName]);
    return { workspace: wsName, view };
}

// "Open in 'Cadrage'" (AC8): the view's name as the sidebar shows it.
function OpenInPill({ m, tabId }: { m: Material; tabId: string }) {
    const t = useT();
    const place = useLivePlace(m, tabId);
    const name = place.view || t("library.panels.thisView");
    return (
        <span className="mt-lib-mat-form is-live" data-testid="library-material-open-in">
            {t("library.materials.openIn", { view: name })}
        </span>
    );
}

function PlaceText({ m, live }: { m: Material; live: { workspace: string; view: string } }) {
    const t = useT();
    const workspaceId = useAtomValue(atoms.workspaceId);
    const place = materialPlaceText(m, live, workspaceId, (name) => (name ? workspaceShownName(name, t) : ""));
    return (
        <span
            className={cn("mt-lib-card-place", place.live && "is-live")}
            data-testid="library-material-place"
            data-place={place.key.split(".").pop()}
        >
            {place.live ? <span className="mt-lib-card-dot" aria-hidden /> : null}
            <span className="min-w-0 truncate">{t(place.key, place.vars)}</span>
        </span>
    );
}

function LivePlaceText({ m, tabId }: { m: Material; tabId: string }) {
    const t = useT();
    const live = useLivePlace(m, tabId);
    return <PlaceText m={m} live={{ workspace: live.workspace, view: live.view || t("library.panels.thisView") }} />;
}

// Where the material lives, right under its title (#1546).
function MaterialPlaceLine({ m, open }: { m: Material; open: ShownPanel }) {
    if (open != null) {
        return <LivePlaceText m={m} tabId={open.tabId} />;
    }
    return <PlaceText m={m} live={null} />;
}

function MaterialFacts({ m, timeOnly, withKind = true }: { m: Material; timeOnly: boolean; withKind?: boolean }) {
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
        withKind ? t(`library.materials.kind.${m.kind}`) : null,
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

function formLabel(t: TFunction, form: MaterialForm, m: Material, locale: string): string {
    const word = t(`library.materials.form.${form.key}`);
    return form.warn && m.size ? `${word} · ${materialSizeText(m.size, locale)}` : word;
}

// The title as rows and cards show it: an address without a readable segment reads "Link · claude.ai".
function shownTitle(t: TFunction, m: Material): string {
    const title = materialDisplayTitle(m) || linkHost(m.link) || m.id;
    if (!materialTitleIsHost(m)) {
        return title;
    }
    return `${t(`library.materials.kind.${m.kind}`)} · ${title}`;
}

function primaryLabel(t: TFunction, open: ShownPanel, plan: MaterialOpen): string {
    if (open) {
        return t("library.materials.showIt");
    }
    return plan?.how === "folder" ? t("library.materials.menu.showInFolder") : t("library.materials.openInView");
}

// ---------- Cards (#1546, DS-MAT-010) ----------

function MaterialVisualBox({ m, large = false }: { m: Material; large?: boolean }) {
    const visual = large ? materialLargeVisual(m) : materialVisual(m);
    const [failed, setFailed] = useState(false);
    const src = visual.path
        ? logoUrl(getWebServerEndpoint(), visual.path) + (visual.version ? `&v=${visual.version}` : "")
        : "";
    useEffect(() => {
        setFailed(false);
    }, [src]);
    if (src && !failed) {
        return (
            <img
                className={cn("mt-lib-card-img", large && "is-large")}
                src={src}
                alt=""
                draggable={false}
                data-testid={large ? "library-detail-image" : "library-material-image"}
                data-kind={m.kind}
                onError={() => setFailed(true)}
            />
        );
    }
    const host = linkHost(m.link).replace(/^www\./, "");
    return (
        <span className="mt-lib-card-icon" data-testid="library-material-icon" aria-hidden>
            <i className={makeIconClass(KindIcons[m.kind] ?? "file", true)} />
            {host ? <span className="mt-lib-card-host">{host}</span> : null}
        </span>
    );
}

// A row's small visual: the same preview as the card's when there is one, else the kind icon.
function RowThumb({ m }: { m: Material }) {
    const visual = materialVisual(m);
    const [failed, setFailed] = useState(false);
    const src = visual.path
        ? logoUrl(getWebServerEndpoint(), visual.path) + (visual.version ? `&v=${visual.version}` : "")
        : "";
    useEffect(() => {
        setFailed(false);
    }, [src]);
    return (
        <span className="mt-lib-mat-th" aria-hidden>
            {src && !failed ? (
                <img className="mt-lib-card-img" src={src} alt="" draggable={false} onError={() => setFailed(true)} />
            ) : (
                <i className={makeIconClass(KindIcons[m.kind] ?? "file", true)} />
            )}
        </span>
    );
}

// The project a material was produced in, when the list mixes several (All projects).
function ProjectChip({ name, className }: { name: string; className?: string }) {
    const t = useT();
    return (
        <span
            className={cn("mt-lib-card-proj", className)}
            title={t("library.materials.projectChip", { name })}
            data-testid="library-material-project"
        >
            {name}
        </span>
    );
}

function MaterialCard({
    m,
    timeOnly,
    selected,
    renaming,
    open,
    handlers,
    onSelect,
    onRenameDone,
    asked,
    projectLabel,
    children,
}: {
    m: Material;
    timeOnly: boolean;
    selected: boolean;
    renaming: boolean;
    open: ShownPanel;
    handlers: RowHandlers;
    onSelect: () => void;
    onRenameDone: () => void;
    asked: boolean;
    projectLabel?: string;
    children?: React.ReactNode;
}) {
    const t = useT();
    const locale = useLocale();
    const chip = materialStateChip(m);
    const plan = materialOpenPlan(m);
    const title = shownTitle(t, m);
    return (
        <div
            role="option"
            tabIndex={selected ? 0 : -1}
            aria-selected={selected}
            aria-label={title}
            className={cn("mt-lib-card", selected && "is-sel")}
            title={m.link || m.copypath || m.original || m.title}
            data-testid="library-material"
            data-material-id={m.id}
            data-kind={m.kind}
            onClick={onSelect}
            onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest?.(".mt-lib-card-title")) {
                    handlers.onRename(m);
                    return;
                }
                if ((e.target as HTMLElement).closest?.("button, [data-lib-escape]")) {
                    return;
                }
                if (plan != null || open != null) {
                    handlers.onOpen(m, plan);
                }
            }}
            onContextMenu={(e) => {
                onSelect();
                showMaterialMenu(e, m, handlers, locale);
            }}
        >
            <div className="mt-lib-card-vis">
                <MaterialVisualBox m={m} />
                <span className={cn("mt-lib-card-kind", `is-${m.kind}`)} data-testid="library-material-kind">
                    <i className={makeIconClass(KindIcons[m.kind] ?? "file", true)} aria-hidden />
                    {t(`library.materials.kind.${m.kind}`)}
                </span>
                {chip ? (
                    <span
                        className={cn("mt-lib-mat-form mt-lib-card-state", chip.warn && "is-warn")}
                        data-testid="library-material-form"
                    >
                        {chip.key === "linkCopy" ? <i className={makeIconClass("cloud", true)} aria-hidden /> : null}
                        {formLabel(t, chip, m, locale)}
                    </span>
                ) : null}
                {projectLabel != null ? <ProjectChip name={projectLabel} className="mt-lib-card-proj-vis" /> : null}
                {!renaming ? (
                    <div className="mt-lib-card-acts">
                        {!asked && (open != null || plan != null) ? (
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
                                {primaryLabel(t, open, plan)}
                                <MoltenWave />
                            </button>
                        ) : null}
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
                    </div>
                ) : null}
            </div>
            <div className="mt-lib-card-body">
                {renaming ? (
                    <RenameField m={m} onDone={onRenameDone} />
                ) : (
                    <div className="mt-lib-card-head">
                        <b className="mt-lib-card-title mt-lib-mat-title">{title}</b>
                        {m.pinned ? (
                            <i
                                className={cn(makeIconClass("thumbtack", true), "mt-lib-mat-pin")}
                                title={t("library.materials.pinned")}
                                aria-label={t("library.materials.pinned")}
                            />
                        ) : null}
                    </div>
                )}
                <MaterialPlaceLine m={m} open={open} />
                <span className="mt-lib-card-origin">
                    <MaterialFacts m={m} timeOnly={timeOnly} withKind={false} />
                </span>
                {children}
            </div>
        </div>
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
    projectLabel,
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
    projectLabel?: string;
}) {
    const t = useT();
    const locale = useLocale();
    const form = materialForm(m);
    const plan = materialOpenPlan(m);
    const formText = formLabel(t, form, m, locale);
    const primary = primaryLabel(t, open, plan);
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
            <RowThumb m={m} />
            {renaming ? (
                <RenameField m={m} onDone={onRenameDone} />
            ) : (
                <span className="mt-lib-mat-tx">
                    <b className="mt-lib-mat-title">{shownTitle(t, m)}</b>
                    <MaterialFacts m={m} timeOnly={timeOnly} />
                </span>
            )}
            {projectLabel != null ? <ProjectChip name={projectLabel} /> : null}
            {m.pinned ? (
                <i
                    className={cn(makeIconClass("thumbtack", true), "mt-lib-mat-pin")}
                    title={t("library.materials.pinned")}
                    aria-label={t("library.materials.pinned")}
                />
            ) : null}
            {open ? (
                <OpenInPill m={m} tabId={open.tabId} />
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
function WhereAsk({ m, plan, onCancel }: { m: Material; plan: MaterialOpen; onCancel: () => void }) {
    const t = useT();
    const tabId = useAtomValue(atoms.staticTabId);
    const workspace = useAtomValue(atoms.workspace);
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
                    onClick={() => {
                        recordPlace(m, {
                            workspaceid: workspace?.oid,
                            workspace: workspace?.name,
                            tabid: tabId,
                            view: identity.name,
                        });
                        fireAndForget(() => openHere(plan));
                    }}
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

// The workspace's project name as the sidebar gives it (the project's declared name, else its folder's name), "" until
// known or without a linked project.
function useWorkspaceProjectName(): string {
    const ws = useAtomValue(atoms.workspace);
    const dir = ws ? readWorkspaceProject(ws).dir : "";
    const [name, setName] = useState("");
    useEffect(() => {
        if (!dir) {
            setName("");
            return;
        }
        let cancelled = false;
        setName(pathBaseName(dir));
        fireAndForget(async () => {
            const facts = await readProjectFacts(dir);
            if (!cancelled && facts?.name) {
                setName(facts.name);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dir]);
    return name;
}

// Whether the section is wide enough for cards, read from its own width (the library's width varies with the window
// and the sidebar, not only the screen).
function useWideEnough(el: HTMLElement, min: number): boolean {
    const [wide, setWide] = useState(false);
    useLayoutEffect(() => {
        if (el == null) {
            return;
        }
        const measure = () => setWide(el.getBoundingClientRect().width >= min);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [el, min]);
    return wide;
}

// ---------- Which project's materials (FR-MAT-002 AC15) ----------

function ScopeChip({
    id,
    selected,
    count,
    onClick,
    children,
}: {
    id: string;
    selected: boolean;
    count?: number;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            className={cn("mt-lib-scope cursor-pointer", selected && "is-on")}
            data-testid={`library-materials-scope-${id}`}
            onClick={onClick}
        >
            <span className="min-w-0 truncate">{children}</span>
            {count != null ? <span className="mt-lib-scope-n">{count}</span> : null}
        </button>
    );
}

function ScopeBar({
    scope,
    onScope,
    activeLabel,
    activeCount,
    allCount,
    noneCount,
    withNone,
    others,
    children,
}: {
    scope: MaterialsScope;
    onScope: (scope: MaterialsScope) => void;
    activeLabel: string;
    activeCount: number;
    allCount: number;
    noneCount: number;
    withNone: boolean;
    others: ScopeProject[];
    children?: React.ReactNode;
}) {
    const t = useT();
    const [picking, setPicking] = useState(false);
    const pickRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!picking) {
            return;
        }
        const onDown = (e: MouseEvent) => {
            if (!pickRef.current?.contains(e.target as Node)) {
                setPicking(false);
            }
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [picking]);
    const chosen = scope.kind === "project" ? others.find((p) => p.key === scope.key) : null;
    return (
        <div className="flex items-center gap-1.5">
            <div
                className="mt-lib-scopes"
                role="radiogroup"
                aria-label={t("library.materials.scope.label")}
                data-testid="library-materials-scope"
                data-scope={scope.kind}
            >
                <ScopeChip
                    id="active"
                    selected={scope.kind === "active"}
                    count={activeCount}
                    onClick={() => onScope({ kind: "active" })}
                >
                    {activeLabel}
                </ScopeChip>
                <div className="relative" ref={pickRef}>
                    <button
                        type="button"
                        role="radio"
                        aria-checked={scope.kind === "project"}
                        aria-haspopup="listbox"
                        aria-expanded={picking}
                        className={cn("mt-lib-scope cursor-pointer", scope.kind === "project" && "is-on")}
                        data-testid="library-materials-scope-other"
                        onClick={() => setPicking((v) => !v)}
                    >
                        <span className="min-w-0 truncate">
                            {chosen ? chosen.name : t("library.materials.scope.other")}
                        </span>
                        {chosen ? <span className="mt-lib-scope-n">{chosen.count}</span> : null}
                        <i className={makeIconClass("chevron-down", true)} aria-hidden />
                    </button>
                    {picking ? (
                        <div
                            className="mt-lib-scope-menu"
                            role="listbox"
                            aria-label={t("library.materials.scope.pick")}
                            data-lib-escape="local"
                            data-testid="library-materials-scope-list"
                            onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setPicking(false);
                                }
                            }}
                        >
                            {others.length === 0 ? (
                                <div className="mt-lib-scope-none">{t("library.materials.scope.noOther")}</div>
                            ) : (
                                others.map((p) => (
                                    <button
                                        key={p.key}
                                        type="button"
                                        role="option"
                                        aria-selected={scope.kind === "project" && scope.key === p.key}
                                        className="mt-lib-scope-opt cursor-pointer"
                                        title={p.folder}
                                        data-testid="library-materials-scope-option"
                                        data-project={p.key}
                                        onClick={() => {
                                            setPicking(false);
                                            onScope({ kind: "project", key: p.key });
                                        }}
                                    >
                                        <span className="min-w-0 truncate">{p.name}</span>
                                        <span className="mt-lib-scope-n">{p.count}</span>
                                    </button>
                                ))
                            )}
                        </div>
                    ) : null}
                </div>
                <ScopeChip
                    id="all"
                    selected={scope.kind === "all"}
                    count={allCount}
                    onClick={() => onScope({ kind: "all" })}
                >
                    {t("library.materials.scope.all")}
                </ScopeChip>
                {withNone ? (
                    <ScopeChip
                        id="none"
                        selected={scope.kind === "none"}
                        count={noneCount}
                        onClick={() => onScope({ kind: "none" })}
                    >
                        {t("library.materials.scope.none")}
                    </ScopeChip>
                ) : null}
            </div>
            {children}
        </div>
    );
}

// ---------- The selected material's panel (FR-MAT-002 AC17) ----------

function MaterialDetail({
    m,
    open,
    handlers,
    projectName,
    renaming,
    onRenameDone,
    onClose,
    children,
}: {
    m: Material;
    open: ShownPanel;
    handlers: RowHandlers;
    projectName: string;
    renaming: boolean;
    onRenameDone: () => void;
    onClose: () => void;
    children?: React.ReactNode;
}) {
    const t = useT();
    const locale = useLocale();
    const chip = materialStateChip(m);
    const plan = materialOpenPlan(m);
    const title = shownTitle(t, m);
    const folder = materialFolderPath(m);
    const keep = materialKeepOffer(m);
    const asked = children != null;
    return (
        <aside
            className="mt-lib-detail"
            aria-label={t("library.materials.detail.label")}
            data-testid="library-material-detail"
            data-material-id={m.id}
            data-lib-escape="local"
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    onClose();
                }
            }}
        >
            <div className="mt-lib-detail-vis">
                <MaterialVisualBox m={m} large />
                <span className={cn("mt-lib-card-kind", `is-${m.kind}`)}>
                    <i className={makeIconClass(KindIcons[m.kind] ?? "file", true)} aria-hidden />
                    {t(`library.materials.kind.${m.kind}`)}
                </span>
                <button
                    type="button"
                    className="mt-lib-detail-close cursor-pointer"
                    title={t("library.materials.detail.close")}
                    aria-label={t("library.materials.detail.close")}
                    data-testid="library-detail-close"
                    onClick={onClose}
                >
                    <i className={makeIconClass("xmark", true)} aria-hidden />
                </button>
            </div>
            <div className="mt-lib-detail-body">
                {renaming ? (
                    <RenameField m={m} onDone={onRenameDone} />
                ) : (
                    <b className="mt-lib-detail-title" data-testid="library-detail-title">
                        {title}
                    </b>
                )}
                <div className="mt-lib-detail-chips">
                    {projectName ? <ProjectChip name={projectName} /> : null}
                    {chip ? (
                        <span className={cn("mt-lib-mat-form", chip.warn && "is-warn")}>
                            {formLabel(t, chip, m, locale)}
                        </span>
                    ) : null}
                </div>
                <MaterialPlaceLine m={m} open={open} />
                <span className="mt-lib-card-origin is-wrap">
                    <MaterialFacts m={m} timeOnly={false} withKind={false} />
                </span>
                {m.link ? <span className="mt-lib-detail-link">{m.link}</span> : null}
                {children}
                {!asked ? (
                    <div className="mt-lib-detail-acts">
                        {open != null || plan != null ? (
                            <button
                                type="button"
                                className="mt-lib-mat-go molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                                data-testid="library-detail-open"
                                onClick={() => handlers.onOpen(m, plan)}
                            >
                                {primaryLabel(t, open, plan)}
                                <MoltenWave />
                            </button>
                        ) : null}
                        <button
                            type="button"
                            className="mt-lib-btn cursor-pointer"
                            data-testid="library-detail-pin"
                            onClick={() => fireAndForget(() => pinMaterial(m, !m.pinned))}
                        >
                            {t(m.pinned ? "library.materials.menu.unpin" : "library.materials.menu.pin")}
                        </button>
                        <button
                            type="button"
                            className="mt-lib-btn cursor-pointer"
                            data-testid="library-detail-rename"
                            onClick={() => handlers.onRename(m)}
                        >
                            {t("library.materials.menu.rename")}
                        </button>
                        {folder ? (
                            <button
                                type="button"
                                className="mt-lib-btn cursor-pointer"
                                onClick={() => showInFolder(folder)}
                            >
                                {t("library.materials.menu.showInFolder")}
                            </button>
                        ) : null}
                        {m.link ? (
                            <button
                                type="button"
                                className="mt-lib-btn cursor-pointer"
                                onClick={() => fireAndForget(() => copyText(m.link, "library.materials.linkCopied"))}
                            >
                                {t("library.materials.menu.copyLink")}
                            </button>
                        ) : null}
                        {keep != null ? (
                            <button
                                type="button"
                                className="mt-lib-btn cursor-pointer"
                                onClick={() => fireAndForget(() => keepCopy(m, keep === "keepanyway"))}
                            >
                                {keep === "keepanyway"
                                    ? t("library.materials.menu.keepAnyway")
                                    : t("library.materials.menu.keepCopy", {
                                          size: materialSizeText(m.size, locale) || "?",
                                      })}
                            </button>
                        ) : null}
                        <button
                            type="button"
                            className="mt-lib-btn cursor-pointer"
                            data-testid="library-detail-delete"
                            onClick={() => handlers.onDelete(m)}
                        >
                            {t("library.materials.menu.delete")}
                        </button>
                    </div>
                ) : null}
            </div>
        </aside>
    );
}

const ArrowMoves: Record<string, GridMove> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
};

export function MaterialsSection({ view, failed, query }: { view: MaterialsView; failed: boolean; query: string }) {
    const t = useT();
    const locale = useLocale();
    const workspaceId = useAtomValue(atoms.workspaceId);
    const panels = useOpenPanels(workspaceId);
    const workspaceProjectName = useWorkspaceProjectName();
    const [selected, setSelected] = useState<string>(null);
    const [detailOpen, setDetailOpen] = useState(false);
    const [renaming, setRenaming] = useState<string>(null);
    const [asking, setAsking] = useState<{ id: string; plan: MaterialOpen }>(null);
    const [deleting, setDeleting] = useState<string>(null);
    const [recover, runRecover, dismissRecover] = useRecover(workspaceId);
    const listRef = useRef<HTMLDivElement>(null);
    const [rootEl, setRootEl] = useState<HTMLDivElement>(null);
    const cards = useWideEnough(rootEl, MaterialsCardsMinWidth);
    const detailRoom = useWideEnough(rootEl, MaterialsDetailMinWidth);
    // The default is always the workspace's project; the choice lasts while the section stays open.
    const [scopeChoice, setScopeChoice] = useState<MaterialsScope>(ActiveScope);
    const workspace = useAtomValue(atoms.workspace);
    const allProjects = useMaterialsAllProjects(workspaceId, workspace ? readWorkspaceProject(workspace).dir : "");
    const activeKey = view?.project?.key ?? "";
    const others = useMemo(
        () => otherProjects(allProjects?.projects, allProjects?.materials, activeKey),
        [allProjects, activeKey]
    );
    const scope = validScope(scopeChoice, others, activeKey);
    const scopeKey = scope.kind === "project" ? scope.key : "";
    const scoped = useMemo(
        () =>
            scope.kind === "active"
                ? view?.materials
                : materialsInScope(
                      allProjects?.materials,
                      { kind: scope.kind, key: scopeKey } as MaterialsScope,
                      activeKey
                  ),
        [view, allProjects, scope.kind, scopeKey, activeKey]
    );
    const shown = useMemo(() => filterMaterials(scoped, query), [scoped, query]);
    const groups = useMemo(() => groupMaterials(shown, Date.now(), locale), [shown, locale]);
    const order = groups.flatMap((g) => g.items);
    // The first row stands selected until the developer picks another.
    const current = order.find((m) => m.id === selected) ?? order[0] ?? null;
    const detail = detailOpen && detailRoom && cards && current != null;
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
    const noProject = activeKey === MaterialsNoProject;
    const named = materialsProjectName(workspaceProjectName, view.project);
    const projectName = noProject ? t("library.materials.noProject") : named;
    const activeLabel =
        noProject || !projectName
            ? projectName || t("library.materials.thisProjectUnnamed")
            : t("library.materials.thisProject", { name: projectName });
    const projectLabelOf = (m: Material): string =>
        m.project === MaterialsNoProject
            ? t("library.materials.noProject")
            : materialProjectName(m, activeKey, named, allProjects?.projects) || m.project.slice(0, 6);
    const projectLabel = (m: Material): string => (scope.kind === "all" ? projectLabelOf(m) : undefined);
    const scopeEmpty = (scoped?.length ?? 0) === 0;
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
        const move = ArrowMoves[e.key];
        if (move != null && (cards || move === "up" || move === "down")) {
            e.preventDefault();
            if (order.length === 0) {
                return;
            }
            const i = Math.max(
                0,
                order.findIndex((m) => m.id === current?.id)
            );
            let j: number;
            if (cards) {
                const rects: CardRect[] = order.map((m) => {
                    const el = listRef.current?.querySelector<HTMLElement>(`[data-material-id="${CSS.escape(m.id)}"]`);
                    const r = el?.getBoundingClientRect();
                    return { left: r?.left ?? 0, top: r?.top ?? 0, width: r?.width ?? 0, height: r?.height ?? 0 };
                });
                j = gridNeighbor(rects, i, move);
            } else {
                j = Math.min(order.length - 1, Math.max(0, i + (move === "down" ? 1 : -1)));
            }
            const next = order[j];
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
    const asksFor = (m: Material) => (
        <>
            {asking?.id === m.id ? (
                <WhereAsk
                    m={m}
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
        </>
    );
    const onlyActiveEmpty = scopeEmpty && scope.kind === "active";
    return (
        <div
            ref={setRootEl}
            className="flex flex-col gap-2"
            data-testid="library-materials"
            data-project={view.project?.key}
            data-layout={cards ? "cards" : "rows"}
            data-scope={scope.kind}
            data-detail={detail ? "open" : "closed"}
        >
            <ScopeBar
                scope={scope}
                onScope={(next) => {
                    setScopeChoice(next);
                    setSelected(null);
                    setAsking(null);
                    setDeleting(null);
                    setRenaming(null);
                }}
                activeLabel={activeLabel}
                activeCount={view.materials?.length ?? 0}
                allCount={allProjects?.materials?.length ?? view.materials?.length ?? 0}
                noneCount={materialsInScope(allProjects?.materials, { kind: "none" }, activeKey).length}
                withNone={!noProject}
                others={others}
            >
                {!noProject ? (
                    <button
                        type="button"
                        className="mt-lib-mat-menu cursor-pointer"
                        title={t("library.materials.sectionMenu")}
                        aria-label={t("library.materials.sectionMenu")}
                        data-testid="library-materials-menu"
                        onClick={(e) => showSectionMenu(e, recover.running, runRecover)}
                    >
                        <i className={makeIconClass("ellipsis", true)} aria-hidden />
                    </button>
                ) : null}
            </ScopeBar>
            <RecoverStatus state={recover} onDismiss={dismissRecover} />
            {shown.length === 0 ? (
                <div className="mt-lib-empty" data-testid="library-materials-empty">
                    <b>
                        {t(
                            onlyActiveEmpty
                                ? "library.materials.emptyTitle"
                                : scopeEmpty
                                  ? "library.materials.scopeEmptyTitle"
                                  : "library.nothingFound"
                        )}
                    </b>
                    {onlyActiveEmpty ? <span>{t("library.materials.empty")}</span> : null}
                    {scopeEmpty && !onlyActiveEmpty ? <span>{t("library.materials.scopeEmpty")}</span> : null}
                    {onlyActiveEmpty && !noProject ? (
                        <>
                            <span>{t("library.materials.recover.hint")}</span>
                            <button
                                type="button"
                                className="molten-btn mt-2 cursor-pointer rounded-4 px-3 py-1.5 text-12"
                                disabled={recover.running}
                                data-testid="library-materials-recover"
                                onClick={runRecover}
                            >
                                {t("library.materials.recover.button")}
                                <MoltenWave />
                            </button>
                        </>
                    ) : null}
                </div>
            ) : (
                <div className={cn("mt-lib-mat-main", detail && "has-detail")}>
                    <div
                        ref={listRef}
                        className="mt-lib-mat-list flex flex-col gap-0.5"
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
                                <div className={cards ? "mt-lib-cards" : "contents"}>
                                    {g.items.map((m) => {
                                        // The panel carries the questions and the title field of the material it shows.
                                        const inPanel = detail && m.id === current?.id;
                                        const props = {
                                            m,
                                            timeOnly: g.timeOnly,
                                            selected: m.id === current?.id,
                                            renaming: renaming === m.id && !inPanel,
                                            asked: asking?.id === m.id || deleting === m.id,
                                            open: findOpenPanel(panels, m) as ShownPanel,
                                            handlers,
                                            projectLabel: projectLabel(m),
                                            onSelect: () => {
                                                setSelected(m.id);
                                                setDetailOpen(true);
                                            },
                                            onRenameDone: () => {
                                                setRenaming(null);
                                                focusRow(m.id);
                                            },
                                        };
                                        if (cards) {
                                            return (
                                                <MaterialCard key={m.id} {...props}>
                                                    {inPanel ? null : asksFor(m)}
                                                </MaterialCard>
                                            );
                                        }
                                        return (
                                            <div key={m.id} className="flex flex-col">
                                                <MaterialRow {...props} />
                                                {asksFor(m)}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                    {detail ? (
                        <MaterialDetail
                            key={current.id}
                            m={current}
                            open={findOpenPanel(panels, current) as ShownPanel}
                            handlers={handlers}
                            projectName={projectLabelOf(current)}
                            renaming={renaming === current.id}
                            onRenameDone={() => {
                                setRenaming(null);
                                focusRow(current.id);
                            }}
                            onClose={() => {
                                setDetailOpen(false);
                                focusRow(current.id);
                            }}
                        >
                            {asking?.id === current.id || deleting === current.id ? asksFor(current) : null}
                        </MaterialDetail>
                    ) : null}
                </div>
            )}
        </div>
    );
}
