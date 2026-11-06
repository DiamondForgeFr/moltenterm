// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { workspace: atom({ oid: "wsA", name: "Alpha" }) },
        createBlock: vi.fn(),
        getApi: () => ({ openNativePath: vi.fn(), switchWorkspace: vi.fn() }),
    };
});
vi.mock("./notifications-store", async () => {
    const { atom } = await import("jotai");
    const entriesAtom = atom([] as any[]);
    const model = {
        entriesAtom,
        shownEntriesAtom: entriesAtom,
        unreadCountAtom: atom(0),
        runningAtom: atom({}),
        errorsAtom: atom({}),
        panelRequestAtom: atom(null),
        settleSeen: vi.fn(),
        markAllRead: vi.fn(),
        clearArchive: vi.fn(),
        archive: vi.fn(),
        open: vi.fn(),
        runAction: vi.fn(),
    };
    return {
        MoltentermNotifications: { getInstance: () => model },
        registerNotificationGesture: vi.fn(() => () => {}),
        startNotificationAutoRead: vi.fn(() => () => {}),
    };
});
vi.mock("./running-work", async () => {
    return {
        canStop: (item: any) => item.id !== "gold-update",
        stopWork: vi.fn(),
        useRunningWork: () => (globalThis as any).__work ?? [],
    };
});
vi.mock("./workspace-rail", () => ({ loadWorkspaceSources: vi.fn(async () => []) }));
vi.mock("./tab-activity", () => ({
    TabActivity: { getInstance: () => ({ every: () => () => {} }) },
    whileShown: () => ({}),
}));
// What the host starts has no use in a render of the center.
vi.mock("./agent-handoff", () => ({ AgentHandoffGesture: "x", answerAgentHandoff: vi.fn() }));
vi.mock("./agent-links/agent-links-model", () => ({ AgentLinksGesture: "y" }));
vi.mock("./agent-links/agent-links-store", () => ({ openAgentLinksGesture: vi.fn() }));
vi.mock("./agent-seen", () => ({ startAgentSeen: vi.fn() }));
vi.mock("./boss/boss-store", () => ({ BossBubbleModel: { getInstance: () => ({ showPanel: vi.fn() }) } }));
vi.mock("./downloads/downloads-notify", () => ({ startDownloads: vi.fn() }));
vi.mock("./downloads/downloads-store", () => ({ DownloadsModel: { getInstance: () => ({}) } }));
vi.mock("./handoff-system-notify", () => ({ startHandoffSystemNotifications: vi.fn() }));
vi.mock("./mission/release-setup-gestures", () => ({ registerSetupPrGestures: vi.fn(() => () => {}) }));
vi.mock("./mission/dep-sync", () => ({ DepSyncHost: () => null }));
vi.mock("./mission/trust-approval", () => ({ TrustApprovalHost: () => null }));
vi.mock("./notification-settings", () => ({ openNotificationSettings: vi.fn() }));
vi.mock("./notification-toasts", () => ({ startNotificationToasts: vi.fn() }));
vi.mock("./project/project-tab", () => ({ showProjectTab: vi.fn() }));
vi.mock("./toast-stack", () => ({ ToastStack: () => null }));
vi.mock("./toast-store", () => ({ Toasts: { getInstance: () => ({}) } }));

import { globalStore } from "@/app/store/jotaiStore";
import { NotificationsPanelBody } from "./notification-center";
import { MoltentermNotifications } from "./notifications-store";

const model = MoltentermNotifications.getInstance() as any;

function entry(id: string, over: Record<string, unknown> = {}) {
    return {
        id,
        time: Date.now() - 60_000,
        updated: Date.now() - 60_000,
        kind: "info",
        read: false,
        source: "agents",
        title: `Title ${id}`,
        message: `Message ${id}`,
        ...over,
    };
}

function render(highlight: string[] = []): string {
    return renderToStaticMarkup(<NotificationsPanelBody onLeave={() => {}} highlightIds={highlight} />);
}

beforeEach(() => {
    globalStore.set(model.entriesAtom, []);
    globalStore.set(model.unreadCountAtom, 0);
    (globalThis as any).__work = [];
});

describe("the notification center, in the Notifications tab (FR-BOSS-009, AC10; FR-MC-019)", () => {
    it("says so in one line when nothing waits", () => {
        const html = render();
        expect(html).toContain('data-testid="notification-empty"');
        expect(html).toContain("Nothing needs your attention.");
    });

    it("lists the notifications, newest as they come, each with its archive and silence actions", () => {
        globalStore.set(model.entriesAtom, [
            entry("n1", { source: "ci" }),
            entry("n2", { kind: "warning", source: "build" }),
        ]);
        const html = render();
        expect(html.match(/data-testid="notification-row"/g)).toHaveLength(2);
        expect(html).toContain('data-notif="n1"');
        expect(html.match(/data-testid="notification-archive"/g)).toHaveLength(2);
        // An info notification of a subject can be silenced: "Don't tell me again…".
        expect(html).toContain('data-testid="notification-silence"');
    });

    it("carries a notification's own actions as buttons", () => {
        globalStore.set(model.entriesAtom, [
            entry("n1", {
                kind: "warning",
                actions: [
                    { id: "a", label: "Allow", kind: "gesture", gesture: "x" },
                    { id: "b", label: "Refuse", kind: "gesture", gesture: "y" },
                ],
            }),
        ]);
        const html = render();
        expect(html.match(/data-testid="notification-action"/g)).toHaveLength(2);
        expect(html).toContain(">Allow<");
        expect(html).toContain(">Refuse<");
    });

    it("marks the notifications the panel was asked to show", () => {
        globalStore.set(model.entriesAtom, [entry("n1"), entry("n2")]);
        const html = render(["n2"]);
        const tags = [...html.matchAll(/<div [^>]*data-testid="notification-row"[^>]*>/g)].map((m) => m[0]);
        expect(tags).toHaveLength(2);
        expect(tags[0]).not.toContain('data-highlighted="true"');
        expect(tags[1]).toContain('data-highlighted="true"');
        expect(tags[1]).toContain('data-notif="n2"');
    });

    it("offers Mark all read while something is unread, and the link to Preferences always", () => {
        expect(render()).not.toContain('data-testid="notification-mark-all-read"');
        expect(render()).toContain('data-testid="notification-settings-link"');
        globalStore.set(model.entriesAtom, [entry("n1")]);
        globalStore.set(model.unreadCountAtom, 1);
        expect(render()).toContain('data-testid="notification-mark-all-read"');
    });

    it("keeps the Archived list, with its clear action, once something was archived", () => {
        globalStore.set(model.entriesAtom, [entry("n1"), entry("n2", { archived: Date.now() })]);
        const html = render();
        expect(html).toContain('data-testid="notification-list-archived"');
        expect(html.match(/data-testid="notification-row"/g)).toHaveLength(1);
        const source = readFileSync(join(__dirname, "notification-center.tsx"), "utf8");
        expect(source).toContain('data-testid="notification-clear-archive"');
        expect(source).toContain("onClick={() => model.clearArchive()}");
    });

    it("shows the work that runs on top, with a Stop that asks first", () => {
        (globalThis as any).__work = [
            {
                id: "run1",
                kind: "build",
                dir: "/p",
                title: "Build the app",
                startedat: Date.now() - 5000,
                progress: 0.4,
            },
            {
                id: "gold-update",
                kind: "update",
                dir: "",
                title: "Updating",
                startedat: Date.now() - 5000,
                progress: -1,
            },
        ];
        const html = render();
        expect(html).toContain("Running");
        expect(html.match(/data-testid="running-work"/g)).toHaveLength(2);
        // The gold update cannot be stopped; the build can, and asks before it does.
        expect(html.match(/data-testid="running-work-stop"/g)).toHaveLength(1);
        expect(html).not.toContain('data-testid="running-work-confirm-stop"');
        const source = readFileSync(join(__dirname, "notification-center.tsx"), "utf8");
        expect(source).toContain('data-testid="running-work-confirm-stop"');
    });

    it("settles what the developer looked at when the tab is left, as the bell's panel did on closing", () => {
        const source = readFileSync(join(__dirname, "notification-center.tsx"), "utf8");
        expect(source).toContain("useEffect(() => () => model.settleSeen(), [model])");
    });
});

describe("the bell is gone, its host is not (FR-BOSS-009, AC9)", () => {
    const source = readFileSync(join(__dirname, "notification-center.tsx"), "utf8");

    it("draws no bell and opens no panel of its own", () => {
        expect(source).not.toContain("notification-bell");
        expect(source).not.toContain("fa-bell");
        expect(source).not.toContain("setPanelOpen");
        expect(source).not.toContain('data-testid="notification-panel"');
    });

    it("keeps hosting the toasts, the approval dialogs and the listeners, and sends a toast's Open to Brokk's panel", () => {
        expect(source).toContain("export function NotificationHost()");
        for (const kept of [
            "<DepSyncHost />",
            "<TrustApprovalHost />",
            "startNotificationToasts()",
            "startDownloads()",
        ]) {
            expect(source, kept).toContain(kept);
        }
        expect(source).toContain('onOpenCenter={() => boss.showPanel("notifications")}');
        expect(source).toContain('boss.showPanel("downloads")');
    });

    it("lets a notification that asks for attention show only in a panel the developer opened", () => {
        expect(source).toContain('boss.showInOpenPanel("notifications", panelRequest.ids)');
    });
});
