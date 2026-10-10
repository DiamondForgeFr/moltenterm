// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
    logos: [] as string[],
    setLogo: vi.fn(async (_ws: string, _logo: string) => {}),
    markOffered: vi.fn(async (_ws: string, _dir: string) => {}),
}));

vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://localhost" }));
vi.mock("./workspace-project-store", () => ({
    findProjectLogos: async () => store.logos,
    readProjectFacts: async () => ({ exists: true, hasPipeline: false, harness: "", name: "Demo" }),
    setWorkspaceLogo: store.setLogo,
    markLogoOffered: store.markOffered,
}));

import { iconOfferToastId, makeIconOffer, offerProjectIcon } from "./project-icon-offer";
import { Toasts } from "./toast-store";

const ws = { oid: "w1", name: "Client A", icon: "rocket", color: "#429DFF", meta: {} } as any as Workspace;

describe("project icon offer (FR-SHELL-059-AC2)", () => {
    beforeEach(() => {
        Toasts.resetInstance();
        store.logos = [];
        store.setLogo.mockClear();
        store.markOffered.mockClear();
    });

    it("offers nothing for a project without an image, and remembers nothing", async () => {
        expect(
            makeIconOffer({
                workspaceId: "w1",
                workspaceName: "Client A",
                dir: "/p",
                projectName: "Demo",
                logos: [],
                thumbnailUrl: (p) => p,
            })
        ).toBeNull();
        expect(await offerProjectIcon(ws, "/p")).toBe("");
        expect(Toasts.getInstance().stack()).toEqual([]);
        expect(store.markOffered).not.toHaveBeenCalled();
    });

    it("shows a toast with the best image as its thumbnail", async () => {
        store.logos = ["/p/icon.png", "/p/logo.svg"];
        const id = await offerProjectIcon(ws, "/p");
        expect(id).toBe(iconOfferToastId("w1"));
        const [toast] = Toasts.getInstance().stack();
        expect(toast).toMatchObject({ title: "Use Demo's logo?", message: "As the icon of Client A", stays: true });
        expect(toast.thumbnail).toBe("http://localhost/wave/stream-local-file?path=%2Fp%2Ficon.png");
        expect(toast.actions.map((a) => a.label)).toEqual(["Use this icon", "Dismiss"]);
    });

    it("sets the image on Use this icon, and remembers the answer either way", async () => {
        store.logos = ["/p/icon.png"];
        await offerProjectIcon(ws, "/p");
        await Toasts.getInstance().stack()[0].actions[0].run();
        expect(store.setLogo).toHaveBeenCalledWith("w1", "/p/icon.png");
        expect(store.markOffered).toHaveBeenCalledWith("w1", "/p");
        expect(Toasts.getInstance().stack()).toEqual([]);

        store.setLogo.mockClear();
        store.markOffered.mockClear();
        await offerProjectIcon(ws, "/p");
        await Toasts.getInstance().stack()[0].actions[1].run();
        expect(store.setLogo).not.toHaveBeenCalled();
        expect(store.markOffered).toHaveBeenCalledWith("w1", "/p");
    });

    it("remembers a closed offer, but lets one pushed out unanswered come back later", async () => {
        store.logos = ["/p/icon.png"];
        const id = await offerProjectIcon(ws, "/p");
        Toasts.getInstance().dismiss(id, "collapsed");
        expect(store.markOffered).not.toHaveBeenCalled();
        await offerProjectIcon(ws, "/p");
        Toasts.getInstance().dismiss(id, "user");
        expect(store.markOffered).toHaveBeenCalledWith("w1", "/p");
    });
});
