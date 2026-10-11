// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./busy-close-store", async () => {
    const { atom } = await import("jotai");
    return { BusyCloseRequestAtom: atom(null) };
});
vi.mock("@/app/store/wos", () => ({ getWaveObjectAtom: vi.fn(), makeORef: vi.fn() }));

import { RunningList } from "./busy-close";
import { RunningItem } from "./busy-close-model";

const cmd = (id: string, label: string): RunningItem => ({
    blockId: id,
    kind: "command",
    label,
    workspace: "Work",
    tab: "api",
});

describe("the running list (DS-SHELL-108)", () => {
    it("names the agent with its state in words, then the command, each with its place", () => {
        const html = renderToStaticMarkup(
            <RunningList
                heading="Closing stops:"
                items={[
                    {
                        blockId: "a",
                        kind: "agent",
                        label: "Claude Code",
                        state: "working",
                        workspace: "Work",
                        tab: "api",
                    },
                    cmd("b", "npm run dev"),
                ]}
            />
        );
        expect(html).toContain("Closing stops:");
        expect(html.indexOf("Claude Code")).toBeLessThan(html.indexOf("npm run dev"));
        expect(html).toContain(">working<");
        expect(html).toContain(">running<");
        expect(html).toContain("Work · api");
        expect(html).toContain('title="npm run dev"');
    });

    it("shows eight rows and how many more", () => {
        const items = Array.from({ length: 10 }, (_, i) => cmd(`c${i}`, `job ${i}`));
        const html = renderToStaticMarkup(<RunningList items={items} />);
        expect(html.match(/data-running-kind="command"/g)).toHaveLength(8);
        expect(html).toContain("and 2 more");
    });

    it("renders nothing when nothing runs", () => {
        expect(renderToStaticMarkup(<RunningList items={[]} />)).toBe("");
    });
});
