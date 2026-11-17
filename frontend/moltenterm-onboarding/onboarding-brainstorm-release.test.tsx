// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// FR-ONB-007 B-5 and FR-BOSS-010 AC1 (#2320): the pour's Brokk scene names /brainstorm on a public release as on a gold.
// The first-run panel asks the window's own gate (the baked channel of the build), and the scene it hands the answer to
// is the real one.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
    pour: null as any,
}));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: {
            workspace: atom({ oid: "ws1", icon: "", name: "Starter workspace" }),
            prefersReducedMotionAtom: atom(false),
        },
        getApi: () => ({
            getIsDev: () => false,
            getEnv: () => "",
            getHomeDir: () => "/Users/ada",
        }),
        replaceBlock: vi.fn(),
    };
});
vi.mock("@/app/store/jotaiStore", async () => {
    const { createStore } = await import("jotai");
    return { globalStore: createStore() };
});
vi.mock("@/app/store/keymodel", () => ({ uxCloseBlock: vi.fn() }));
vi.mock("@/app/store/services", () => ({ WorkspaceService: { UpdateWorkspace: vi.fn() } }));
vi.mock("@/app/store/tab-model", async () => {
    const { atom } = await import("jotai");
    const tabAtom = atom({ oid: "tab1", blockids: ["b1"] });
    return { getActiveTabModel: () => ({ tabAtom }) };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/element/errorboundary", async () => {
    const React = await import("react");
    return { ErrorBoundary: (props: any) => React.createElement(React.Fragment, null, props.children) };
});
vi.mock("../moltenterm-shell/mission/mission-client", () => ({ missionGitInit: vi.fn() }));
vi.mock("../moltenterm-shell/sidebar/view-pins-store", () => ({ ViewPins: { getInstance: () => ({}) } }));
vi.mock("../moltenterm-shell/workspace-project-store", () => ({
    chooseMoltentermPath: vi.fn(),
    setWorkspaceFolder: vi.fn(),
    linkWorkspaceProject: vi.fn(),
    readProjectFacts: vi.fn(),
}));
vi.mock("./onboarding-client", () => ({
    listOnboardingAgents: vi.fn(),
    scanProjectCandidates: vi.fn(async () => []),
    onboardingUpdate: vi.fn(),
}));
vi.mock("./onboarding-pour", () => ({
    OnboardingPour: (props: any) => {
        world.pour = props;
        return null;
    },
}));
vi.mock("./onboarding-brokk-face", () => ({ OnboardingBrokkFace: () => null }));
vi.mock("../moltenterm-shell/boss/boss-store", async () => {
    const { atom } = await import("jotai");
    const model = { nameAtom: atom("Brokk"), showAtom: atom(true) };
    return { BossBubbleModel: { getInstance: () => model } };
});
// The developer's switches are read from the client object: the window's gate does not depend on them any more.
vi.mock("../moltenterm-shell/build/features-narrowing", () => ({
    currentNarrowing: () => ({ public: false, off: [] }),
    useNarrowing: () => ({ public: false, off: [] }),
}));

import { BrokkScene } from "./onboarding-pour-brokk";
import { FirstRunPanel, OnboardingViewModel } from "./onboarding-view";

// A public release: the baked channel of the build, read once by the window's gate. Stubbed before the first render.
vi.stubGlobal("__MOLTENTERM_BUILD__", { channel: "public", version: "1.0.0" });

describe("the pour's Brokk scene on a public release", () => {
    it("names /brainstorm and draws its example, as on a gold", () => {
        const model = new OnboardingViewModel({ blockId: "b1", nodeModel: null } as any);
        renderToStaticMarkup(<FirstRunPanel model={model} {...({} as any)} />);
        expect(world.pour.brokk).toMatchObject({ name: "Brokk", off: false, brainstorm: true });

        const html = renderToStaticMarkup(<BrokkScene intro={world.pour.brokk} />);
        expect(html).toContain('data-testid="pour-brokk-brainstorm"');
        expect(html).toMatch(/type <code[^>]*>\/brainstorm<\/code>/);
    });
});
