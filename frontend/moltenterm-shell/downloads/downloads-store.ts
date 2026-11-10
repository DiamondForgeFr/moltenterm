// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The windows' side of the downloads (FR-MC-019 AC7-AC13, #1992): Electron main tracks them (emain/moltenterm-
// downloads.ts) and tells every window the whole list; this keeps it as atoms and carries the questions the surfaces
// ask. It knows no surface: the bell's Downloads tab, Brokk's tab and the page's pill only read these atoms and call
// these methods, so a surface can move without touching anything here.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, PrimitiveAtom } from "jotai";
import {
    DownloadActRequest,
    DownloadActResult,
    DownloadRecord,
    DownloadsSnapshot,
    isActive,
    overallDownloadProgress,
    RingProgress,
    runningDownloads,
} from "./downloads-model";
import { goToPage, goToView, loadOriginFacts, reopenPage } from "./downloads-origin";
import { OriginState, originState } from "./downloads-origin-model";
import { runningRingEntries, TrackedTransfer, TransferSource } from "./tracked-transfer";

export type DownloadsTransferSource = TransferSource<Atom<TrackedTransfer[]>>;

type DownloadsElectronApi = {
    moltentermDownloadsList?: () => Promise<DownloadsSnapshot>;
    moltentermDownloadsAct?: (request: DownloadActRequest) => Promise<DownloadActResult>;
    moltentermDownloadsClear?: () => Promise<number>;
    moltentermDownloadsCheck?: () => Promise<DownloadsSnapshot>;
    onMoltentermDownloadsChanged?: (callback: (snapshot: DownloadsSnapshot) => void) => () => void;
    onMoltentermDownloadsNotify?: (
        callback: (notice: { record: DownloadRecord; outcome: "done" | "failed" }) => void
    ) => () => void;
};

// Every call degrades to "no downloads" where the Electron API is missing (the preview server, a test).
function api(): DownloadsElectronApi {
    return (typeof window === "undefined" ? {} : (getApi() ?? {})) as DownloadsElectronApi;
}

export const EmptyDownloads: DownloadsSnapshot = { items: [], folder: "", askWhere: false };

// What a window asks of the surfaces: show the Downloads section, perhaps on one row, perhaps with that row's
// confirmation open. seq tells two requests for the same row apart.
export type DownloadsRequest = { seq: number; id?: string; confirm?: boolean };

export class DownloadsModel {
    private static instance: DownloadsModel = null;

    snapshotAtom = atom(EmptyDownloads) as PrimitiveAtom<DownloadsSnapshot>;
    // What each row says about where it came from, read when the section shows.
    originsAtom = atom({}) as PrimitiveAtom<Record<string, OriginState>>;
    // The last failure of an action per download: a code the row words.
    errorsAtom = atom({}) as PrimitiveAtom<Record<string, string>>;
    // A surface that wants the Downloads section on screen (a notification's View, the pill) sets this; the surface
    // that hosts the section reads it. Nothing opens by itself.
    requestAtom = atom(null) as PrimitiveAtom<DownloadsRequest>;
    // How many lists are on screen: a notification raised while the section is open arrives already read.
    visibleAtom = atom(0) as PrimitiveAtom<number>;
    itemsAtom: Atom<DownloadRecord[]>;
    runningAtom: Atom<DownloadRecord[]>;
    // The ring: the mean of what runs and knows its size, null when nothing does.
    progressAtom: Atom<number>;
    // The other sources of downloads (#2163): each owns its state and gives the section tracked transfers.
    sourcesAtom = atom([]) as PrimitiveAtom<DownloadsTransferSource[]>;
    transfersAtom: Atom<TrackedTransfer[]>;
    // What Brokk's ring, his words and the rail count: the running downloads and the running transfers.
    ringAtom: Atom<RingProgress[]>;

    private stops: (() => void)[] = [];
    private started = false;
    private heard = false;

    private constructor() {
        this.itemsAtom = atom((get) => get(this.snapshotAtom).items);
        this.runningAtom = atom((get) => runningDownloads(get(this.itemsAtom)));
        this.progressAtom = atom((get) => overallDownloadProgress(get(this.runningAtom)));
        this.transfersAtom = atom((get) =>
            get(this.sourcesAtom).flatMap((source) => (get(source.transfersAtom) ?? []).filter((t) => t != null))
        );
        this.ringAtom = atom((get) => [...get(this.runningAtom), ...runningRingEntries(get(this.transfersAtom))]);
    }

    // A source plugs in for as long as it lives; the returned function takes it out.
    registerSource(source: DownloadsTransferSource): () => void {
        const others = globalStore.get(this.sourcesAtom).filter((s) => s.id !== source.id);
        globalStore.set(this.sourcesAtom, [...others, source]);
        return () => {
            globalStore.set(
                this.sourcesAtom,
                globalStore.get(this.sourcesAtom).filter((s) => s !== source)
            );
        };
    }

    async actTransfer(transferId: string, actionId: string): Promise<void> {
        const source = globalStore
            .get(this.sourcesAtom)
            .find((s) => (globalStore.get(s.transfersAtom) ?? []).some((t) => t?.id === transferId));
        if (source == null) {
            return;
        }
        try {
            await source.act(transferId, actionId);
        } catch (e) {
            console.log("downloads: the transfer's action failed", e?.message ?? e);
        }
    }

    static getInstance(): DownloadsModel {
        if (!DownloadsModel.instance) {
            DownloadsModel.instance = new DownloadsModel();
        }
        return DownloadsModel.instance;
    }

    static resetInstance(): void {
        DownloadsModel.instance?.stop();
        DownloadsModel.instance = null;
    }

    items(): DownloadRecord[] {
        return globalStore.get(this.itemsAtom);
    }

    find(id: string): DownloadRecord {
        return this.items().find((r) => r.id === id) ?? null;
    }

    // Reads the list main keeps and follows what it tells: called once per window.
    start(): () => void {
        if (this.started) {
            return () => this.stop();
        }
        this.started = true;
        const electron = api();
        this.stops.push(
            electron.onMoltentermDownloadsChanged?.((snapshot) => {
                this.heard = true;
                this.apply(snapshot);
            }) ?? (() => {})
        );
        void electron
            .moltentermDownloadsList?.()
            ?.then((snapshot) => {
                // What main pushed meanwhile is newer than the answer to this first read.
                if (!this.heard) {
                    this.apply(snapshot);
                }
            })
            .catch((e) => console.log("downloads: reading the list failed", e?.message ?? e));
        return () => this.stop();
    }

    stop(): void {
        this.stops.forEach((stop) => stop());
        this.stops = [];
        this.started = false;
        this.heard = false;
    }

    apply(snapshot: DownloadsSnapshot): void {
        if (snapshot == null || !Array.isArray(snapshot.items)) {
            return;
        }
        globalStore.set(this.snapshotAtom, snapshot);
    }

    async act(request: DownloadActRequest): Promise<DownloadActResult> {
        const act = api().moltentermDownloadsAct;
        if (act == null) {
            return { ok: false, error: "failed" };
        }
        let result: DownloadActResult;
        try {
            result = await act(request);
        } catch (e) {
            console.log("downloads: the action failed", e?.message ?? e);
            result = { ok: false, error: "failed" };
        }
        // The question that comes before opening a program is asked in the entry, it is no failure.
        if (request.id != null) {
            this.setError(request.id, result.ok || result.error === "executable" ? "" : (result.error ?? "failed"));
        }
        return result;
    }

    private setError(id: string, code: string): void {
        const errors = { ...globalStore.get(this.errorsAtom) };
        if (code) {
            errors[id] = code;
        } else {
            delete errors[id];
        }
        globalStore.set(this.errorsAtom, errors);
    }

    clearError(id: string): void {
        this.setError(id, "");
    }

    async clear(): Promise<number> {
        try {
            return (await api().moltentermDownloadsClear?.()) ?? 0;
        } catch (e) {
            console.log("downloads: clearing the history failed", e?.message ?? e);
            return 0;
        }
    }

    // Which finished files are still there: when the section opens and the window gets the focus back.
    async check(): Promise<void> {
        try {
            const snapshot = await api().moltentermDownloadsCheck?.();
            if (snapshot != null) {
                this.apply(snapshot);
            }
        } catch (e) {
            console.log("downloads: checking the files failed", e?.message ?? e);
        }
    }

    // Reads what exists of the place each download came from (one read per view), then what each row says.
    async refreshOrigins(): Promise<void> {
        const items = this.items();
        const factsByView = new Map<string, Awaited<ReturnType<typeof loadOriginFacts>>>();
        const current = globalStore.get(atoms.workspace)?.oid;
        const next: Record<string, OriginState> = {};
        for (const record of items) {
            const key = `${record.workspaceId}/${record.tabId}`;
            if (!factsByView.has(key)) {
                factsByView.set(key, await loadOriginFacts(record));
            }
            next[record.id] = originState(record, factsByView.get(key), current);
        }
        globalStore.set(this.originsAtom, next);
    }

    // Follows a row's way back to its page. What exists is read again at the click: a page closed since the row was
    // drawn is not a dead button, the row simply says what is true now. Returns whether the window left for the place.
    async followOrigin(id: string, how: "page" | "reopen" | "view"): Promise<boolean> {
        const record = this.find(id);
        if (record == null) {
            return false;
        }
        const facts = await loadOriginFacts(record);
        const state = originState(record, facts, globalStore.get(atoms.workspace)?.oid);
        globalStore.set(this.originsAtom, { ...globalStore.get(this.originsAtom), [id]: state });
        if (how === "page" && state.cta === "goto") {
            await goToPage(record);
            return true;
        }
        if (how === "reopen" && state.cta === "reopen") {
            return reopenPage(record, facts);
        }
        if (how === "view" && state.toView) {
            await goToView(record);
            return true;
        }
        return false;
    }

    // The question a surface asks to have the section shown, on a row, with that row's confirmation open.
    request(id?: string, confirm?: boolean): void {
        const seq = (globalStore.get(this.requestAtom)?.seq ?? 0) + 1;
        globalStore.set(this.requestAtom, { seq, id, confirm: confirm === true });
    }

    setVisible(delta: number): void {
        globalStore.set(this.visibleAtom, Math.max(0, globalStore.get(this.visibleAtom) + delta));
    }

    isVisible(): boolean {
        return globalStore.get(this.visibleAtom) > 0;
    }

    activeCount(): number {
        return this.items().filter(isActive).length;
    }

    onNotify(callback: (notice: { record: DownloadRecord; outcome: "done" | "failed" }) => void): () => void {
        return api().onMoltentermDownloadsNotify?.(callback) ?? (() => {});
    }
}
