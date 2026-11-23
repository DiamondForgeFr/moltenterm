// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nModel, t } from "../i18n/i18n";
import { PermissionRequestCard, permissionTerminalOf, PermitRequestCard } from "./companion-permission";
import type { PermitRequest } from "./companion-permit-model";

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

// #2474: the request MoltenTerm holds for the companion is answered here.
const held: PermitRequest = {
    id: "r1",
    blockid: "b1",
    sessionid: "11111111-2222-3333-4444-555555555555",
    agent: "claude",
    tool: "Bash",
    toolinput: { command: "go test ./..." },
    cwd: "/Users/me/work/app",
    at: 1_000_000,
    state: "held",
    deadline: 1_000_000 + 112_000,
};

function card(over: { agent?: string; now?: number; busy?: boolean; error?: string } = {}, req: PermitRequest = held) {
    return {
        request: req,
        t,
        agent: "Flore",
        now: 1_000_000,
        onAnswer: vi.fn(),
        onShowTerminal: vi.fn(),
        ...over,
    };
}

describe("the permission card of a held request (#2474)", () => {
    it("says who asks what, shows the exact command, the tool and the project, and the three answers", () => {
        const html = renderToStaticMarkup(<PermitRequestCard {...card()} />);
        expect(html).toContain("Flore wants to run a command");
        expect(html).toContain('data-testid="companion-permit-text">go test ./...</pre>');
        expect(html).toContain("Tool: Bash · folder: app");
        expect(html).toContain('data-testid="companion-permit-allow"');
        expect(html).toContain(">Allow<");
        expect(html).toContain(">Deny<");
        expect(html).toContain(">Answer in the terminal<");
        expect(html).toContain("Goes back to the terminal in 1:52");
        expect(html).not.toContain("companion-permit-denylist");
        expect(html).toContain('aria-label="Answer the request of Flore"');
    });

    it("counts the time left of each agent: Codex's hook leaves 12 seconds, not two minutes", () => {
        const codex = { ...held, agent: "codex", deadline: 1_000_000 + 12_000 };
        expect(renderToStaticMarkup(<PermitRequestCard {...card({}, codex)} />)).toContain(
            "Goes back to the terminal in 0:12"
        );
        expect(renderToStaticMarkup(<PermitRequestCard {...card({ now: 1_000_000 + 130_000 })} />)).toContain(
            "Goes back to the terminal in 0:00"
        );
    });

    it("answers with what was clicked, and nothing is clicked while an answer is on its way", () => {
        const props = card();
        const element = PermitRequestCard(props);
        const click = (id: string) => find(element, (n) => n.props?.["data-testid"] === id).props.onClick();
        click("companion-permit-allow");
        click("companion-permit-deny");
        click("companion-permit-terminal");
        expect(props.onAnswer.mock.calls.map((c) => c[0])).toEqual(["allow", "deny", "terminal"]);
        const busy = PermitRequestCard(card({ busy: true }));
        for (const id of ["companion-permit-allow", "companion-permit-deny", "companion-permit-terminal"]) {
            expect(find(busy, (n) => n.props?.["data-testid"] === id).props.disabled).toBe(true);
        }
        expect(renderToStaticMarkup(<PermitRequestCard {...card({ busy: true })} />)).toContain('aria-busy="true"');
    });

    it("says when an answer did not go through", () => {
        const html = renderToStaticMarkup(<PermitRequestCard {...card({ error: "The answer did not go through." })} />);
        expect(html).toContain('role="alert"');
        expect(html).toContain("The answer did not go through.");
    });

    it("reads each kind of request, and the tool's whole input when it is not a command", () => {
        const edit = { ...held, tool: "Edit", toolinput: { file_path: "/w/a.ts", new_string: "x" } };
        const html = renderToStaticMarkup(<PermitRequestCard {...card({ agent: "" }, edit)} />);
        expect(html).toContain("The agent wants to change a file");
        expect(html).toContain("file_path");
        expect(html).toContain("Tool: Edit · folder: app");
        const web = { ...held, tool: "WebFetch", toolinput: { url: "https://example.com" }, cwd: "" };
        const webHtml = renderToStaticMarkup(<PermitRequestCard {...card({}, web)} />);
        expect(webHtml).toContain("Flore wants to reach the web");
        expect(webHtml).toContain("Tool: WebFetch<");
        expect(renderToStaticMarkup(<PermitRequestCard {...card({}, { ...held, tool: "mcp__x__y" })} />)).toContain(
            "wants to use a tool"
        );
    });

    it("never offers Allow for a request shown cut, and says why", () => {
        const cut = renderToStaticMarkup(<PermitRequestCard {...card({}, { ...held, clipped: true })} />);
        expect(cut).toContain('data-testid="companion-permit-clipped"');
        expect(cut).toContain(t("companion.permit.clipped"));
        expect(cut).not.toContain('data-testid="companion-permit-allow"');
        expect(cut).toContain('data-testid="companion-permit-deny"');
        expect(cut).toContain('data-testid="companion-permit-terminal"');
        const whole = renderToStaticMarkup(<PermitRequestCard {...card()} />);
        expect(whole).not.toContain('data-testid="companion-permit-clipped"');
        expect(whole).toContain('data-testid="companion-permit-allow"');
    });

    it("shows nothing without a request", () => {
        expect(PermitRequestCard({ ...card(), request: null })).toBeNull();
    });

    it("reads in French", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const html = renderToStaticMarkup(<PermitRequestCard {...card()} />);
            expect(html).toContain("Flore veut lancer une commande");
            expect(html).toContain("Autoriser");
            expect(html).toContain("Refuser");
            expect(html).toContain("Répondre dans le terminal");
            expect(html).toContain("Repasse au terminal dans 1:52");
            expect(html).toContain("Outil : Bash · dossier : app");
        } finally {
            i18n.setLanguageSetting("");
        }
    });
});

describe("the permission card of a request the deny list keeps (#2474)", () => {
    const denied: PermitRequest = {
        ...held,
        toolinput: { command: "git push --force origin main" },
        state: "terminal",
        deadline: undefined,
        reason: "force push or deletion of a main branch: main",
        reasontext: { code: "keepawake.deny.forcepush", vars: { detail: "main" } },
    };

    it("offers no answer but the terminal, says why, and never counts down", () => {
        const html = renderToStaticMarkup(<PermitRequestCard {...card({}, denied)} />);
        expect(html).toContain("git push --force origin main");
        expect(html).toContain('data-testid="companion-permit-denylist"');
        expect(html).toContain(
            "Force push or deletion of a main branch: main. This one is always answered in the terminal, even in autonomous mode."
        );
        expect(html).toContain("fa-triangle-exclamation");
        expect(html).toContain('data-testid="companion-permission-terminal"');
        expect(html).toContain(t("companion.goToTerminal"));
        for (const absent of [
            "companion-permit-allow",
            'companion-permit-deny"',
            "companion-permit-countdown",
            "companion-permit-actions",
        ]) {
            expect(html).not.toContain(absent);
        }
    });

    it("goes to the terminal on a click", () => {
        const props = card({}, denied);
        const element = PermitRequestCard(props);
        find(element, (n) => n.props?.["data-testid"] === "companion-permission-terminal").props.onClick();
        expect(props.onShowTerminal).toHaveBeenCalledTimes(1);
        expect(props.onAnswer).not.toHaveBeenCalled();
    });

    it("still says what it is without a reason", () => {
        const html = renderToStaticMarkup(
            <PermitRequestCard {...card({}, { ...denied, reason: undefined, reasontext: undefined })} />
        );
        expect(html).toContain("This one is always answered in the terminal, even in autonomous mode.");
    });
});

describe("the transcript's card of a run that cannot be held (#2474)", () => {
    it("keeps today's way to the terminal, with a one-line hint when the agent has to restart", () => {
        const html = renderToStaticMarkup(
            <PermissionRequestCard
                request={request}
                t={t}
                onShowTerminal={() => {}}
                hint={t("companion.permit.restart")}
            />
        );
        expect(html).toContain("Restart the agent to answer from here");
        expect(html).toContain('data-testid="companion-permission-terminal"');
        expect(
            renderToStaticMarkup(<PermissionRequestCard request={request} t={t} onShowTerminal={() => {}} />)
        ).not.toContain("Restart the agent");
    });
});
