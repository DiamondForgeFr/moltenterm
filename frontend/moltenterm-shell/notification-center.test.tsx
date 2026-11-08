// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The notification center's list is the Notifications panel of Brokk's group (boss/brokk-notes-panel.test.tsx); what stays
// here is its host.
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

    it("leaves the list to the group's Notifications panel and keeps the running work and the row boundary it uses", () => {
        expect(source).not.toContain("NotificationsPanelBody");
        expect(source).toContain("export function WorkRow(");
        expect(source).toContain("export class RowBoundary");
    });
});
