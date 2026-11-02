// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { ClientModel } from "@/app/store/client-model";
import { atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import en from "../i18n/locales/en.json";
import { MoltentermNotification, NotificationKeyPrefix } from "../notifications-model";
import { AgentBar } from "../reviews/reviews-agent-bar";
import { TrustPrompt } from "./runs-view";
import { trustAskOf, trustReviewAction, TrustReviewGesture } from "./trust-approval-model";

function trustEntry(over: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return {
        id: "n1",
        key: "molten:trust:/p/App",
        source: "trust",
        title: "App's commands need your approval",
        kind: "warning",
        time: 1,
        updated: 1,
        read: false,
        actions: [
            {
                id: "review",
                label: "Review the commands",
                kind: "gesture",
                gesture: TrustReviewGesture,
                args: { dir: "/p/App", blockids: ["b1", "b2"] },
            },
        ],
        ...over,
    };
}

vi.mock("react-dom", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-dom")>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

beforeAll(() => {
    vi.stubGlobal("document", { body: {} });
});

// The notifications every window reads from the client's meta: set before the store is first read.
ClientModel.getInstance().clientAtom = atom({
    meta: {
        [NotificationKeyPrefix + "n1"]: trustEntry(),
        [NotificationKeyPrefix + "n2"]: trustEntry({
            id: "n2",
            key: "molten:trust:/p/Old",
            resolved: 5,
            actions: [
                {
                    id: "review",
                    label: "Review the commands",
                    kind: "gesture",
                    gesture: TrustReviewGesture,
                    args: { dir: "/p/Old", blockids: ["b9"] },
                },
            ],
        }),
    },
} as unknown as Client);

describe("trust approval (#1017)", () => {
    it("finds the folder an agent's refused run waits on, while the question is open", () => {
        expect(trustAskOf([trustEntry()], "b2")).toBe("/p/App");
        expect(trustAskOf([trustEntry()], "b3")).toBe("");
        expect(trustAskOf([trustEntry({ resolved: 10 })], "b1")).toBe("");
        expect(trustAskOf([trustEntry({ source: "ci" })], "b1")).toBe("");
        expect(trustAskOf([trustEntry()], "")).toBe("");
    });

    it("opens the sheet from the notification itself, and only for a trust notification", () => {
        expect(trustReviewAction(trustEntry())?.id).toBe("review");
        expect(trustReviewAction(trustEntry({ source: "build" }))).toBeNull();
    });

    it("offers Review the commands on the refused agent's Reviews line only", () => {
        const refused = renderToStaticMarkup(
            <AgentBar
                facts={{ kind: "panel", blockId: "b1", agent: "claude", name: "Olivia", state: "waiting", since: 1 }}
            />
        );
        expect(refused).toContain('data-testid="reviews-agent-trust"');
        expect(refused).toContain(en.reviewsAgents.trustReview);
        expect(refused).toMatch(/molten-btn[^"]*cursor-pointer/);
        for (const blockId of ["b5", "b9"]) {
            const other = renderToStaticMarkup(
                <AgentBar
                    facts={{ kind: "panel", blockId, agent: "claude", name: "Olivia", state: "waiting", since: 1 }}
                />
            );
            expect(other).not.toContain("reviews-agent-trust");
        }
    });

    it("approves without running: Trust instead of Trust and run, the folder and the exact commands", () => {
        const info = { hash: "h", commands: [{ kind: "ci", id: "test", title: "Tests", run: "npm test", cwd: "web" }] };
        const props = { projectName: "App", dir: "/p/App", info, onTrust: () => {}, onCancel: () => {} };
        const approve = renderToStaticMarkup(<TrustPrompt {...props} approveOnly />);
        expect(approve).toContain(">" + en.mc.trust.trust + "<");
        expect(approve).not.toContain(en.mc.trust.trustAndRun);
        expect(approve).toContain("/p/App");
        expect(approve).toContain("web$ npm test");
        const run = renderToStaticMarkup(<TrustPrompt {...props} />);
        expect(run).toContain(en.mc.trust.trustAndRun);
    });
});
