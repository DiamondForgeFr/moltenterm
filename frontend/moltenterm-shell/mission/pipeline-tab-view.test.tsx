// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { prerenderToNodeStream } from "react-dom/static";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shown = vi.hoisted(() => ({ props: null as any, meta: {} as Record<string, unknown>, closes: 0 }));

vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getWaveObjectAtom: () => atom({ oid: "panel", meta: shown.meta }),
}));
vi.mock("../review/review-tab-close", () => ({
    closeThisTab: () => {
        shown.closes++;
    },
}));
const asked = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock("./pipeline-agent-ui", () => ({ PipelineHelp: () => null }));
vi.mock("./pipeline-agent", () => ({
    askPipelineAgent: async (...args: unknown[]) => {
        asked.calls.push(args);
        return "sent";
    },
}));
vi.mock("./release-setup", async () => {
    const { useAskAgent } = await import("./pipeline-tab-context");
    return {
        ReleaseSetup: (props: any) => {
            shown.props = { ...props, askAgent: useAskAgent() };
            return null;
        },
    };
});

import { PipelinePanelMetaKey } from "./pipeline-tab-model";
import { PipelineViewModel } from "./pipeline-tab-view";

async function render(meta: Record<string, unknown>) {
    shown.meta = meta;
    shown.props = null;
    const model = new PipelineViewModel({ blockId: "panel", nodeModel: null } as any);
    const View = model.viewComponent;
    const { prelude } = await prerenderToNodeStream(<View model={model} blockRef={null} contentRef={null} />);
    let html = "";
    for await (const chunk of prelude) {
        html += chunk;
    }
    return html;
}

describe("the pipeline setup's panel", () => {
    beforeEach(() => {
        shown.closes = 0;
    });

    it("hosts the stepper for the tab's project, resuming at the saved step", async () => {
        await render({ view: "molten-pipeline", [PipelinePanelMetaKey]: { dir: "/work/app", project: "App" } });
        expect(shown.props.dir).toBe("/work/app");
        expect(shown.props.projectName).toBe("App");
        expect(shown.props.openAt).toBeUndefined();
    });

    it("closes through the Review tab's close path, which leaves the saved answers alone", async () => {
        await render({ view: "molten-pipeline", [PipelinePanelMetaKey]: { dir: "/work/app", openat: "understand" } });
        expect(shown.props.openAt).toBe("understand");
        shown.props.onClose();
        expect(shown.closes).toBe(1);
    });

    it("gives the screens it hosts the tab's askAgent", async () => {
        await render({ view: "molten-pipeline", [PipelinePanelMetaKey]: { dir: "/work/app", project: "App" } });
        expect(await shown.props.askAgent({ context: "Step 4" })).toBe("sent");
        expect(asked.calls).toEqual([["/work/app", "App", "panel", { context: "Step 4" }]]);
    });

    it("says so when the panel names no project", async () => {
        const html = await render({ view: "molten-pipeline" });
        expect(shown.props).toBeNull();
        expect(html).toContain("No project to set up");
    });
});
