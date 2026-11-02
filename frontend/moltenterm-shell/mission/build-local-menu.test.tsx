// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    states: [] as any[],
    reveal: vi.fn(),
    open: vi.fn(),
}));
vi.mock("react", async (original) => ({
    ...(await original<typeof import("react")>()),
    useState: () => [mocks.states.shift(), vi.fn()],
    useEffect: () => {},
}));
vi.mock("@/app/store/global", () => ({ getApi: () => ({ revealNativePath: mocks.reveal, openNativePath: mocks.open }) }));
vi.mock("../i18n/i18n", async (original) => ({
    ...(await original<typeof import("../i18n/i18n")>()),
    useT: () => (key: string) => key,
}));

import { BuildLocalMenu } from "./build-local-menu";

function find(node: any, predicate: (node: any) => boolean): any {
    if (node == null || typeof node !== "object") return null;
    if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
    if (predicate(node)) return node;
    return find(node.props?.children, predicate);
}

describe("build folder action", () => {
    it.each([
        { artifact: "/tmp/Example.app", manifest: "/tmp/build.json", last: { commit: "abc" }, target: "/tmp/Example.app" },
        { artifact: "/tmp/build #1.exe", manifest: "/tmp/build.json", last: { commit: "abc", app: "Example" }, target: "/tmp/build #1.exe" },
        { artifact: "", manifest: "/tmp/build.json", last: { commit: "abc" }, target: "/tmp/build.json" },
    ])("wires the folder button to reveal $target without launching it", ({ artifact, manifest, last, target }) => {
        mocks.reveal.mockClear();
        mocks.open.mockClear();
        mocks.states = [
            true,
            { builds: [{ id: "build", artifact, manifest, last }] },
            false, null, false, null, null,
        ];
        const element = BuildLocalMenu({ dir: "/tmp/project", projectName: "Example", running: null, onBuild: vi.fn(), onShowRun: vi.fn() });
        const button = find(element, (node) => node.type === "button" && node.props.title === "mc.builds.showInFolder");
        expect(button).toBeTruthy();
        button.props.onClick();
        expect(mocks.reveal).toHaveBeenCalledExactlyOnceWith(target);
        expect(mocks.open).not.toHaveBeenCalled();
    });
});
