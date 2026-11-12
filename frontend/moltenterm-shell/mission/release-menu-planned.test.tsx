// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Release menu offers the planned next version first (FR-MC-015, #2268), on synthetic data: last tag v1.1.0, the
// next station is milestone v1.1.1 (due first, its issues closed), develop carries 2 features.

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    states: [] as any[],
    setters: [] as any[],
    releaseStart: vi.fn(),
}));
vi.mock("react", async (original) => ({
    ...(await original<typeof import("react")>()),
    useState: () => {
        const setter = vi.fn();
        mocks.setters.push(setter);
        return [mocks.states.shift(), setter];
    },
    useEffect: () => {},
    useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("../i18n/i18n", async (original) => {
    const real = await original<typeof import("../i18n/i18n")>();
    return { ...real, useT: () => real.t };
});
vi.mock("./release-setup-client", () => ({ setupCheck: vi.fn() }));
vi.mock("./mission-client", () => ({
    missionTrust: vi.fn(),
    missionRefresh: vi.fn(),
    releaseMilestone: vi.fn(),
    releaseStart: mocks.releaseStart,
    MissionRouteId: "molten:mission",
}));
vi.mock("./runs-view", () => ({ TrustPrompt: () => null }));
vi.mock("./pipeline-tab-open", () => ({ openSetupTab: vi.fn() }));

import { RawTag } from "./mission-model";
import { ReleaseMenu } from "./release-menu";
import { PlannedRelease, plannedRelease, ReleaseChannel, releasePlan, ReleasePlan } from "./release-model";
import { releaseState } from "./versions";

const Steps = [{ id: "prepare", run: "true" }] as any[];
const Station = { tag: "v1.1.1", milestonefirst: true, bigger: true };

function planOf(names: string[]): ReleasePlan {
    const features = ["feat(#1): a tour", "feat(#2): help pages"].map((subject, i) => ({
        sha: `f${i}`,
        date: "2026-11-05",
        subject,
    }));
    const tags: RawTag[] = names.map((name) => ({
        name,
        date: "2026-11-01",
        sha: "c" + name,
        notes: null,
        notesInternal: null,
    }));
    return releasePlan(releaseState(tags, features, features), names);
}

type MenuState = {
    plan: ReleasePlan;
    planned: PlannedRelease;
    choice?: ReleaseChannel;
    fromPlan?: boolean;
    confirming?: boolean;
    confirmedTag?: string;
};

// The menu's useState calls, in order: open, plan, planned, choice, fromPlan, confirming, confirmedTag, version, busy,
// error, setupError, untrusted, drift, anchor, setupState, milestone.
const Setter = { confirming: 5, confirmedTag: 6 };

function renderMenu(s: MenuState): any {
    mocks.setters = [];
    mocks.states = [
        true,
        s.plan,
        s.planned,
        s.choice ?? null,
        s.fromPlan ?? false,
        s.confirming ?? false,
        s.confirmedTag ?? null,
        s.plan.publicVersion ?? "",
        false,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
    ];
    return ReleaseMenu({
        dir: "/tmp/synthetic",
        projectName: "Synthetic",
        session: null,
        rcSteps: Steps,
        publicSteps: Steps,
        milestones: [],
        onStarted: vi.fn(),
        onShowRelease: vi.fn(),
    });
}

function findAll(node: any, predicate: (node: any) => boolean, out: any[] = []): any[] {
    if (node == null || typeof node !== "object") {
        return out;
    }
    if (Array.isArray(node)) {
        node.forEach((child) => findAll(child, predicate, out));
        return out;
    }
    if (predicate(node)) {
        out.push(node);
    }
    findAll(node.props?.children, predicate, out);
    return out;
}

const channelTitles = (tree: any) =>
    findAll(tree, (n) => n.type?.name === "ChannelButton").map((n) => n.props.title as string);
const byTestId = (tree: any, id: string) =>
    findAll(tree, (n) => n.props?.testId === id || n.props?.["data-testid"] === id)[0];
const startButton = (tree: any) =>
    findAll(tree, (n) => n.type === "button" && String(n.props.className).includes("molten-btn"))[0];

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the Release menu offers the planned next version (FR-MC-015, #2268)", () => {
    const plan = planOf(["v1.1.0"]);
    const planned = plannedRelease(plan, Station);

    it("offers the station's RC and public release first, then the computed number with its reason", () => {
        const tree = renderMenu({ plan, planned });
        expect(channelTitles(tree)).toEqual([
            "Release candidate v1.1.1-1",
            "Public release v1.1.1",
            "Release candidate v1.2.0-1",
            "Public release v1.2.0",
        ]);
        expect(byTestId(tree, "release-planned-heading").props.children).toBe("Planned: next station v1.1.1");
        expect(byTestId(tree, "release-computed-reason").props.children).toBe(
            "v1.2.0 follows the commits: 2 new features, a minor version."
        );
    });

    it("asks for a confirmation before starting the planned number, and nothing starts meanwhile", async () => {
        mocks.releaseStart.mockReset();
        const tree = renderMenu({ plan, planned, choice: "public", fromPlan: true });
        expect(startButton(tree).props.children).toContain("Start v1.1.1");
        startButton(tree).props.onClick();
        await settle();
        expect(mocks.setters[Setter.confirming]).toHaveBeenCalledWith(true);
        expect(mocks.releaseStart).not.toHaveBeenCalled();
    });

    it("starts the planned tag once confirmed, through the same release steps", async () => {
        mocks.releaseStart.mockReset();
        mocks.releaseStart.mockResolvedValue({ session: { tag: "v1.1.1" } });
        const tree = renderMenu({ plan, planned, choice: "public", fromPlan: true, confirming: true });
        const confirm = findAll(tree, (n) => n.type?.name === "PlannedConfirm")[0];
        expect(confirm.props.text).toBe(
            "The commits call for a minor version (v1.2.0): 2 new features. Start v1.1.1 as planned all the same?"
        );
        expect(startButton(tree).props.disabled).toBe(true);
        confirm.props.onStart();
        await settle();
        expect(mocks.setters[Setter.confirmedTag]).toHaveBeenCalledWith("v1.1.1");
        expect(mocks.releaseStart).toHaveBeenCalledExactlyOnceWith("/tmp/synthetic", "public", "v1.1.1", false);
    });

    it("does not ask again for a tag already confirmed, and starts the planned RC", async () => {
        mocks.releaseStart.mockReset();
        mocks.releaseStart.mockResolvedValue({});
        const tree = renderMenu({ plan, planned, choice: "rc", fromPlan: true, confirmedTag: "v1.1.1-1" });
        startButton(tree).props.onClick();
        await settle();
        expect(mocks.releaseStart).toHaveBeenCalledExactlyOnceWith("/tmp/synthetic", "rc", "v1.1.1-1", undefined);
    });

    it("starts the computed number without a confirmation", async () => {
        mocks.releaseStart.mockReset();
        mocks.releaseStart.mockResolvedValue({});
        const tree = renderMenu({ plan, planned, choice: "public", fromPlan: false });
        startButton(tree).props.onClick();
        await settle();
        expect(mocks.setters[Setter.confirming]).not.toHaveBeenCalledWith(true);
        expect(mocks.releaseStart).toHaveBeenCalledExactlyOnceWith("/tmp/synthetic", "public", "v1.2.0", undefined);
    });

    it("is unchanged without a planned version: the station is the computed number, or there is no milestone", () => {
        for (const station of [{ tag: "v1.2.0", milestonefirst: true }, null]) {
            const tree = renderMenu({ plan, planned: plannedRelease(plan, station) });
            expect(channelTitles(tree)).toEqual(["Release candidate v1.2.0-1", "Public release v1.2.0"]);
            expect(byTestId(tree, "release-planned-heading")).toBeUndefined();
        }
    });

    it("does not offer the station's number once it is tagged, and says why", () => {
        const tagged = { ...plan, tags: ["v1.1.0", "v1.1.1"] };
        const tree = renderMenu({ plan: tagged, planned: plannedRelease(tagged, Station) });
        expect(channelTitles(tree)).toEqual(["Release candidate v1.2.0-1", "Public release v1.2.0"]);
        expect(byTestId(tree, "release-planned-refused").props.children).toBe(
            "v1.1.1, the next station, is already tagged: only the computed number is offered."
        );
    });
});
