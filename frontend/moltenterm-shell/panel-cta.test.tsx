// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What each family of call to action hands the door (#1844, FR-SHELL-139 AC13): the panel it is in, the click's
// modifiers, the tooltip that says how to get a new view. The doors themselves are tested in open-from-panel.test.ts.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
    opened: [] as { view: string; origin: unknown }[],
    mac: true,
}));

vi.mock("@/util/platformutil", () => ({ isMacOS: () => env.mac }));
vi.mock("./open-view", () => ({
    openMoltentermView: async (view: string, origin?: unknown) => {
        env.opened.push({ view, origin });
    },
}));

import { PanelOrigin } from "./app-panel-model";
import { CicdViewType, openCicdTab } from "./mission/cicd-open";
import { useNewViewHint, usePanelOrigin } from "./panel-cta";
import { ReviewsModel } from "./reviews/reviews-store";
import { PanelBlockIdContext } from "./view360/offcarpet-model";

function Probe({ click }: { click?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } }) {
    const origin = usePanelOrigin();
    const hint = useNewViewHint();
    return <i data-origin={JSON.stringify(origin(click))} data-hint={hint("Open CI/CD")} />;
}

function probe(blockId: string, click?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) {
    const html = renderToStaticMarkup(
        <PanelBlockIdContext.Provider value={blockId}>
            <Probe click={click} />
        </PanelBlockIdContext.Provider>
    );
    const origin = /data-origin="([^"]*)"/.exec(html)?.[1].replace(/&quot;/g, '"');
    const hint = /data-hint="([^"]*)"/.exec(html)?.[1];
    return { origin: JSON.parse(origin) as PanelOrigin, hint };
}

beforeEach(() => {
    env.opened = [];
    env.mac = true;
});

describe("the origin of a call to action", () => {
    it("is the panel it is rendered in", () => {
        expect(probe("block-project").origin).toEqual({ blockId: "block-project", newView: false });
    });

    it("asks for a new view from Shift, and from the platform's command key", () => {
        expect(probe("b", { shiftKey: true }).origin.newView).toBe(true);
        expect(probe("b", { metaKey: true }).origin.newView).toBe(true);
        expect(probe("b", { ctrlKey: true }).origin.newView).toBe(false);
        env.mac = false;
        expect(probe("b", { ctrlKey: true }).origin.newView).toBe(true);
        expect(probe("b", { metaKey: true }).origin.newView).toBe(false);
    });

    it("has no panel outside a panel", () => {
        const html = renderToStaticMarkup(<Probe />);
        expect(html).toContain("&quot;blockId&quot;:null");
        expect(html).toContain("&quot;newView&quot;:false");
    });

    it("tells the tooltip how to open the panel in a new view", () => {
        expect(probe("b").hint).toBe("Open CI/CD (Shift-click: in a new view)");
    });
});

describe("the release card's link to the CI (Release run)", () => {
    it("opens the CI/CD panel from the panel the card is in, and keeps the Remote tab it asks for", async () => {
        const origin = { blockId: "block-project", newView: false };
        await openCicdTab("remote", origin);
        expect(env.opened).toEqual([{ view: CicdViewType, origin }]);
        const { CicdTabRequestAtom } = await import("./mission/cicd-open");
        const { globalStore } = await import("@/app/store/jotaiStore");
        expect(globalStore.get(CicdTabRequestAtom)).toMatchObject({ tab: "remote" });
    });

    it("stays an app action without an origin", async () => {
        await openCicdTab("remote");
        expect(env.opened).toEqual([{ view: CicdViewType, origin: undefined }]);
    });
});

describe("Integration, opened from the CI/CD panel, a page's test context or the pipeline setup", () => {
    it("opens beside the panel the call is in, on the PR it names", async () => {
        const origin = { blockId: "block-cicd", newView: false };
        const model = ReviewsModel.getInstance();
        await model.openReviews("/shop", 12, undefined, origin);
        expect(env.opened).toEqual([{ view: "molten-reviews", origin }]);
        const { globalStore } = await import("@/app/store/jotaiStore");
        expect(globalStore.get(model.focusAtom)).toMatchObject({ dir: "/shop", number: 12 });
    });

    it("asks for a new view when the click did", async () => {
        const origin = { blockId: "block-browser", newView: true };
        await ReviewsModel.getInstance().openReviews("/shop", 0, "feature/3-x", origin);
        expect(env.opened).toEqual([{ view: "molten-reviews", origin }]);
    });

    it("stays an app action from the rail, a notification or the top field", async () => {
        await ReviewsModel.getInstance().openReviews();
        expect(env.opened).toEqual([{ view: "molten-reviews", origin: undefined }]);
    });
});
