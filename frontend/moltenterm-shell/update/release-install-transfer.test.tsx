// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The in-app update in Brokk's Downloads (#2163, FR-BOSS-009 AC61-AC62): the installer's state is fed from a fake, and
// the row, its actions, the list and the ring on Brokk's face follow it. No download runs.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom({ oid: "ws-origin" }) }, getApi: () => ({}) };
});
vi.mock("@/app/store/services", () => ({ ObjectService: {}, WorkspaceService: {} }));
vi.mock("@/app/store/tab-model", async () => {
    const { atom } = await import("jotai");
    return { activeTabIdAtom: atom("tab-origin") };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../tab-activity", () => ({
    TabActivity: { getInstance: () => ({ every: () => () => {} }) },
    whileShown: () => ({}),
}));
vi.mock("../settings/settings-open", () => ({ openSettingsSection: vi.fn(async () => {}) }));
// The update store's own atoms and methods, as Settings › About uses them: a fake that the tests feed.
vi.mock("./release-update-store", async () => {
    const { atom } = await import("jotai");
    const fake = {
        installAtom: atom({ phase: "idle" }),
        offerAtom: atom(null),
        cancel: vi.fn(async () => {}),
        apply: vi.fn(async () => {}),
        reveal: vi.fn(async () => {}),
        install: vi.fn(async () => {}),
    };
    return { ReleaseUpdateModel: { getInstance: () => fake } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { downloadRingOf } from "../downloads/downloads-model";
import { DownloadsModel } from "../downloads/downloads-store";
import { DownloadsList } from "../downloads/downloads-view";
import { openSettingsSection } from "../settings/settings-open";
import { ReleaseOffer } from "./release-feed";
import { ReleaseInstallState } from "./release-install";
import { releaseTransferOf } from "./release-install-transfer";
import { startReleaseTransfers } from "./release-install-transfer-source";
import { ReleaseUpdateModel } from "./release-update-store";

const Offer: ReleaseOffer = {
    tag: "v1.0.0-11",
    version: "1.0.0-11",
    url: "https://example.com/r",
    notes: "",
    publishedat: "",
} as ReleaseOffer;
const fake = ReleaseUpdateModel.getInstance() as any;
const model = DownloadsModel.getInstance();

const Downloading: ReleaseInstallState = {
    phase: "downloading",
    tag: Offer.tag,
    version: Offer.version,
    mode: "swap",
    percent: 37,
};
const Verifying: ReleaseInstallState = { phase: "verifying", tag: Offer.tag, version: Offer.version, mode: "swap" };
const ReadySwap: ReleaseInstallState = {
    phase: "ready",
    tag: Offer.tag,
    version: Offer.version,
    mode: "swap",
    armed: true,
};
const ReadyDownload: ReleaseInstallState = {
    phase: "ready",
    tag: Offer.tag,
    version: Offer.version,
    mode: "download",
    file: "/home/dev/Downloads/moltenterm.deb",
};
const FailedNetwork: ReleaseInstallState = {
    phase: "error",
    tag: Offer.tag,
    version: Offer.version,
    mode: "swap",
    error: { kind: "network" },
};
const FailedSignature: ReleaseInstallState = { ...FailedNetwork, error: { kind: "signature" } };

function feed(state: ReleaseInstallState, offer: ReleaseOffer = Offer) {
    globalStore.set(fake.installAtom, state);
    globalStore.set(fake.offerAtom, offer);
}

let stop: () => void;

beforeEach(() => {
    vi.clearAllMocks();
    globalStore.set(model.snapshotAtom, { items: [], folder: "", askWhere: false });
    feed({ phase: "idle" });
    stop = startReleaseTransfers();
});

afterEach(() => stop());

describe("the update's row, from the installer's state", () => {
    it("downloading: its percentage and Cancel only", () => {
        const row = releaseTransferOf(Downloading, Offer);
        expect(row).toMatchObject({ phase: "running", received: 37, total: 100 });
        expect(row.title).toEqual({ key: "downloads.update.title", vars: { version: "1.0.0-11" } });
        expect(row.actions.map((a) => a.id)).toEqual(["cancel"]);
    });

    it("downloading without a known size: running, no percentage", () => {
        const row = releaseTransferOf({ ...Downloading, percent: undefined }, Offer);
        expect(row).toMatchObject({ phase: "running", total: 0 });
    });

    it("verifying: no action", () => {
        const row = releaseTransferOf(Verifying, Offer);
        expect(row).toMatchObject({ phase: "verifying", status: { key: "downloads.update.verifying" } });
        expect(row.actions).toEqual([]);
    });

    it("ready where the app replaces itself: Restart now and Open the Update panel, never Open or Delete", () => {
        const row = releaseTransferOf(ReadySwap, Offer);
        expect(row.phase).toBe("done");
        expect(row.actions.map((a) => a.id)).toEqual(["restart", "openupdate"]);
        expect(row.actions.find((a) => a.id === "openupdate").leaves).toBe(true);
    });

    it("ready where the file is kept in the Downloads folder: Show in folder", () => {
        const row = releaseTransferOf(ReadyDownload, Offer);
        expect(row.actions.map((a) => a.id)).toEqual(["reveal"]);
    });

    it("failed: the reason, and Try again only when trying again can cure it", () => {
        const network = releaseTransferOf(FailedNetwork, Offer);
        expect(network).toMatchObject({
            phase: "failed",
            failed: true,
            status: { key: "update.install.error.network" },
        });
        expect(network.actions.map((a) => a.id)).toEqual(["retry"]);
        const signature = releaseTransferOf(FailedSignature, Offer);
        expect(signature.status.key).toBe("update.install.error.signature");
        expect(signature.actions).toEqual([]);
        expect(releaseTransferOf(FailedNetwork, null).actions).toEqual([]);
    });

    it("none: no row", () => {
        expect(releaseTransferOf({ phase: "idle" }, Offer)).toBeNull();
        expect(releaseTransferOf(null, Offer)).toBeNull();
    });
});

describe("Brokk's Downloads and his ring follow the update", () => {
    it("the row shows with the Update panel's percentage, and the ring is on", () => {
        feed(Downloading);
        const html = renderToStaticMarkup(<DownloadsList />);
        expect(html).toContain('data-testid="transfer-row"');
        expect(html).toContain("MoltenTerm 1.0.0-11");
        expect(html).toContain("37%");
        expect(html).toContain('data-testid="transfer-cancel"');
        expect(html).not.toContain('data-testid="transfer-restart"');
        expect(html).not.toContain('data-testid="downloads-empty"');
        expect(downloadRingOf(globalStore.get(model.ringAtom))).toBeCloseTo(0.37);
    });

    it("verifying keeps the ring on without a size", () => {
        feed(Verifying);
        expect(downloadRingOf(globalStore.get(model.ringAtom))).toBe(-1);
    });

    it("a staged update is no longer running: the ring is off, the row offers its restart", () => {
        feed(ReadySwap);
        expect(downloadRingOf(globalStore.get(model.ringAtom))).toBeNull();
        const html = renderToStaticMarkup(<DownloadsList />);
        expect(html).toContain('data-testid="downloads-transfers"');
        expect(html).toContain('data-testid="transfer-restart"');
        expect(html).toContain('data-testid="transfer-openupdate"');
        expect(html).not.toContain('data-testid="download-open"');
        expect(html).not.toContain('data-testid="download-remove"');
    });

    it("without an update, the panel shows no such row", () => {
        feed({ phase: "idle" });
        const html = renderToStaticMarkup(<DownloadsList />);
        expect(html).not.toContain('data-testid="transfer-row"');
        expect(html).toContain('data-testid="downloads-empty"');
        expect(globalStore.get(model.ringAtom)).toEqual([]);
    });

    it("once the source stops, its row goes", () => {
        feed(Downloading);
        stop();
        expect(globalStore.get(model.transfersAtom)).toEqual([]);
        stop = () => {};
    });
});

describe("the row's actions are the update store's own", () => {
    const id = `release:${Offer.tag}`;

    it("Cancel cancels the update's download", async () => {
        feed(Downloading);
        await model.actTransfer(id, "cancel");
        expect(fake.cancel).toHaveBeenCalledTimes(1);
    });

    it("Restart now does what the Update panel's button does", async () => {
        feed(ReadySwap);
        await model.actTransfer(id, "restart");
        expect(fake.apply).toHaveBeenCalledWith("now");
        await model.actTransfer(id, "openupdate");
        expect(openSettingsSection).toHaveBeenCalledWith("about");
    });

    it("Show in folder and Try again", async () => {
        feed(ReadyDownload);
        await model.actTransfer(id, "reveal");
        expect(fake.reveal).toHaveBeenCalledTimes(1);
        feed(FailedNetwork);
        await model.actTransfer(id, "retry");
        expect(fake.install).toHaveBeenCalledTimes(1);
    });

    it("an action on a row that is gone does nothing", async () => {
        feed({ phase: "idle" });
        await model.actTransfer(id, "cancel");
        expect(fake.cancel).not.toHaveBeenCalled();
    });
});
