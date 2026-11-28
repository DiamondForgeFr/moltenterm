// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2583 (FR-SHELL-084, FR-CONT-015): an agent whose turn ended with only a service left running (a dev server, a daemon)
// is not at work. Its row keeps its own state, says what runs on its second line, wears a calm plug where the dominoes
// would be, and is not among the active agents; its tree lists the service.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { Provider } from "jotai";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import enLocale from "../i18n/locales/en.json";
import frLocale from "../i18n/locales/fr.json";
import { AgentsSection } from "./sidebar-agents";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

const Css = readFileSync(new URL("./sidebar-agents.css", import.meta.url), "utf8");

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
});

function seedBlock(blockId: string, meta: Record<string, unknown>) {
    globalStore.get(WOS.getWaveObjectAtom(WOS.makeORef("block", blockId)));
    WOS.setObjectValue({ otype: "block", oid: blockId, version: 1, meta } as any);
}

function render(agents: AgentStateInfo[]) {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <AgentsSection agents={agents} activeTabId="tab-a" />
        </Provider>
    );
}

function rowOf(html: string, blockId: string): string {
    const start = html.indexOf(`data-block-id="${blockId}"`);
    expect(start, blockId).toBeGreaterThanOrEqual(0);
    const next = html.indexOf('data-testid="sidebar-agent"', start + 1);
    return html.slice(start, next < 0 ? undefined : next);
}

function agent(blockid: string, firstname: string, state: AgentStateInfo["state"], more: Partial<AgentStateInfo> = {}) {
    return {
        blockid,
        tabid: "tab-a",
        workspaceid: "ws1",
        agent: "claude",
        agentname: "Claude Code",
        firstname,
        state,
        version: 1,
        ...more,
    } as AgentStateInfo;
}

const Daemon = "Molten browser daemon";

describe("the row of an agent that left a service running", () => {
    it("stays done, with the service on its second line and a plug, and no dominoes", () => {
        const row = rowOf(render([agent("svc-done", "Basile", "done", { services: [Daemon] })]), "svc-done");
        expect(row).toContain('data-state="done"');
        expect(row).toContain("is-service");
        expect(row).toContain("mt-sb-av is-done");
        expect(row).toContain(`mt-sb-agent-ss">Service running: ${Daemon}</span>`);
        expect(row).toContain('data-testid="sidebar-agent-service"');
        expect(row).toContain(`aria-label="Service running: ${Daemon}"`);
        expect(row).toContain("lucide-plug");
        expect(row).not.toContain("df-domino-loader");
        expect(row).not.toContain("mt-sb-agent-dom");
        expect(row).not.toContain("sidebar-agent-subs-pill");
    });

    it("says on the row and on the plug that the service does not count as active", () => {
        const row = rowOf(render([agent("svc-title", "Basile", "done", { services: [Daemon] })]), "svc-title");
        const hint = "Left running by the agent; it does not count as active";
        expect(row.match(new RegExp(hint, "g"))?.length).toBeGreaterThanOrEqual(2);
        expect(row).toContain(`done · Service running: ${Daemon}`);
    });

    it("keeps the same look when the agent is idle", () => {
        const row = rowOf(render([agent("svc-idle", "Basile", "idle", { services: [Daemon] })]), "svc-idle");
        expect(row).toContain('data-state="idle"');
        expect(row).toContain("is-service");
        expect(row).toContain("sidebar-agent-service");
        expect(row).not.toContain("df-domino-loader");
    });

    it("words several services by their count, and a service without words as 'Service running'", () => {
        const two = rowOf(render([agent("svc-two", "Basile", "done", { services: [Daemon, "Dev server"] })]), "svc-two");
        expect(two).toContain('mt-sb-agent-ss">2 services running</span>');
        const unnamed = rowOf(render([agent("svc-anon", "Basile", "done", { services: [""] })]), "svc-anon");
        expect(unnamed).toContain('mt-sb-agent-ss">Service running</span>');
    });

    it("keeps the words and the mark of a working agent: its services show in the tree only", () => {
        const row = rowOf(
            render([agent("svc-work", "Basile", "working", { services: [Daemon], message: "fixing #12" })]),
            "svc-work"
        );
        expect(row).toContain('data-state="working"');
        expect(row).toContain("mt-sb-agent-dom");
        expect(row).toContain("fixing #12");
        expect(row).not.toContain("is-service");
        expect(row).not.toContain("sidebar-agent-service");
    });

    it("keeps the words of an agent that waits for the developer, or failed", () => {
        const waiting = rowOf(
            render([agent("svc-wait", "Basile", "waiting", { services: [Daemon], message: "Approve the push?" })]),
            "svc-wait"
        );
        expect(waiting).toContain("Approve the push?");
        expect(waiting).not.toContain("sidebar-agent-service");
        const failed = rowOf(
            render([agent("svc-err", "Basile", "error", { services: [Daemon], message: "Exited with code 1" })]),
            "svc-err"
        );
        expect(failed).toContain("Exited with code 1");
        expect(failed).not.toContain("sidebar-agent-service");
    });

    it("shows nothing for an agent that left no service", () => {
        const row = rowOf(render([agent("svc-none", "Basile", "done")]), "svc-none");
        expect(row).not.toContain("is-service");
        expect(row).not.toContain("sidebar-agent-service");
        expect(row).toContain("done");
    });
});

describe("the counter of the agents", () => {
    const Count = 'data-testid="sidebar-agents-count">';

    it("says 'at rest' when the only agent has only a service left", () => {
        const html = render([agent("cnt-a", "Basile", "done", { services: [Daemon] })]);
        expect(html).toContain(`${Count}at rest<`);
    });

    it("counts the working agents, not the one that left a service", () => {
        const html = render([
            agent("cnt-b", "Basile", "done", { services: [Daemon] }),
            agent("cnt-c", "Clara", "working"),
            agent("cnt-d", "Dario", "working", { services: ["Dev server"] }),
            agent("cnt-e", "Elsa", "waiting"),
        ]);
        expect(html).toContain(`${Count}3 active<`);
    });
});

describe("the tree of an agent with services", () => {
    it("lists a Services section with the plug and the words of each service, before the link to everything", () => {
        seedBlock("tree-a", { "molten:agenttree": { open: true } });
        const row = rowOf(render([agent("tree-a", "Basile", "done", { services: [Daemon, ""] })]), "tree-a");
        expect(row).toContain('data-testid="sidebar-agent-section-services"');
        expect(row).toMatch(/sidebar-agent-section-services"[\s\S]*?<span>Services<\/span><span class="mt-sb-tl-n">2<\/span>/);
        const leaves = row.match(/data-testid="sidebar-agent-service-leaf"/g) ?? [];
        expect(leaves).toHaveLength(2);
        expect(row).toContain(`<span class="mt-sb-leaf-t">${Daemon}</span>`);
        expect(row).toContain('<span class="mt-sb-leaf-t">Service running</span>');
        expect(row.indexOf("sidebar-agent-section-services")).toBeLessThan(row.indexOf("sidebar-agent-everything"));
        expect(row).toContain("mt-sb-leaf is-static is-svc");
    });

    it("lists them for a working agent too, in every state", () => {
        seedBlock("tree-w", { "molten:agenttree": { open: true } });
        const row = rowOf(render([agent("tree-w", "Basile", "working", { services: [Daemon] })]), "tree-w");
        expect(row).toContain('data-testid="sidebar-agent-section-services"');
        expect(row).toContain(`<span class="mt-sb-leaf-t">${Daemon}</span>`);
    });

    it("folds its leaves with the section and has no section without a service", () => {
        seedBlock("tree-shut", { "molten:agenttree": { open: true, shut: { services: true } } });
        const shut = rowOf(render([agent("tree-shut", "Basile", "done", { services: [Daemon] })]), "tree-shut");
        expect(shut).toContain('aria-expanded="false" data-testid="sidebar-agent-section-services"');
        expect(shut).not.toContain("sidebar-agent-service-leaf");

        seedBlock("tree-none", { "molten:agenttree": { open: true } });
        const none = rowOf(render([agent("tree-none", "Basile", "done")]), "tree-none");
        expect(none).not.toContain("sidebar-agent-section-services");
    });
});

describe("the look of a service", () => {
    it("is a calm plug in the discreet text, with no animation, drawn in tokens", () => {
        const mark = Css.slice(Css.indexOf(".mt-sb-agent-svc {"));
        const block = mark.slice(0, mark.indexOf("}"));
        expect(block).toContain("color: var(--mt-text-3)");
        expect(block).not.toMatch(/animation|transition|#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    });

    it("reads one step brighter than the discreet text, so the done row's dimming leaves it readable", () => {
        const line = Css.slice(Css.indexOf(".mt-sb-arow.is-service .mt-sb-agent-ss {"));
        expect(line.slice(0, line.indexOf("}"))).toContain("color: var(--mt-text-2)");
        expect(Css).toContain(".mt-sb-arow.is-done {\n    opacity: 0.62;");
    });
});

describe("the words of a service, in both languages", () => {
    it("has every key with the same placeholders", () => {
        for (const dict of [enLocale as any, frLocale as any]) {
            expect(dict.sidebar.agents.service).toContain("{name}");
            expect(dict.sidebar.agents.serviceUnnamed).toBeTypeOf("string");
            expect(dict.sidebar.agents.serviceTitle).toBeTypeOf("string");
            expect(dict.sidebar.agents.services.one).toContain("{count}");
            expect(dict.sidebar.agents.services.other).toContain("{count}");
            expect(dict.agentInfo.services).toBeTypeOf("string");
        }
    });

    it("says it in French with the language's spacing", () => {
        const fr = (frLocale as any).sidebar.agents;
        expect(fr.service).toBe("Service actif : {name}");
        expect(fr.serviceUnnamed).toBe("Service actif");
        expect(fr.services.other).toBe("{count} services actifs");
        expect(fr.serviceTitle).toBe("Laissé en marche par l'agent ; il ne compte pas comme actif");
    });
});
