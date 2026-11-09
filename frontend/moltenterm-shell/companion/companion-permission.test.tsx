// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { t } from "../i18n/i18n";
import { PermissionRequestCard, permissionTerminalOf } from "./companion-permission";

const request = { id: "c1", tool: "Bash", args: '{"command":"ls"}' } as any;

function find(node: any, predicate: (node: any) => boolean): any {
    if (node == null || typeof node !== "object") return null;
    if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
    if (predicate(node)) return node;
    return find(node.props?.children, predicate);
}

describe("the Companion's permission card (#2155)", () => {
    it("has a button that goes to the terminal", () => {
        const html = renderToStaticMarkup(<PermissionRequestCard request={request} t={t} onShowTerminal={() => {}} />);
        expect(html).toContain('data-testid="companion-permission-terminal"');
        expect(html).toContain(t("companion.goToTerminal"));
        expect(html).toContain("Bash");
    });

    it("shows and focuses the agent's pane on a click", () => {
        const onShowTerminal = vi.fn();
        const card = PermissionRequestCard({ request, t, onShowTerminal });
        const button = find(card, (n) => n.props?.["data-testid"] === "companion-permission-terminal");
        button.props.onClick();
        expect(onShowTerminal).toHaveBeenCalledTimes(1);
    });

    it("shows nothing without a request", () => {
        expect(PermissionRequestCard({ request: null, t, onShowTerminal: () => {} })).toBeNull();
    });

    it("goes to the terminal where the agent's state says it is", () => {
        const info = { blockid: "term-1", tabid: "tab-1", workspaceid: "ws-1", version: 1 };
        expect(permissionTerminalOf("term-1", info)).toEqual({
            workspaceid: "ws-1",
            tabid: "tab-1",
            blockid: "term-1",
        });
        expect(permissionTerminalOf("term-1", null)).toEqual({
            workspaceid: undefined,
            tabid: undefined,
            blockid: "term-1",
        });
        expect(permissionTerminalOf("", info)).toBeNull();
    });
});
