// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHookOffer } from "./agent-hooks-model";

const hookState = vi.hoisted(() => ({
    offer: null as AgentHookOffer,
    dismiss: vi.fn(),
    refresh: vi.fn(),
    apply: vi.fn(),
    remove: vi.fn(),
}));

vi.mock("react-dom", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-dom")>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});
vi.mock("./dialog-frame", () => ({
    DialogFrame: ({ role, title, subtitle, children, buttons }: any) => (
        <div data-role={role}>
            <h1>{title}</h1>
            <p>{subtitle}</p>
            {children}
            <div>{buttons}</div>
        </div>
    ),
}));
vi.mock("./molten-button", () => ({ MoltenWave: () => null }));
vi.mock("./term-copy/term-copy", () => ({ openFileInPreview: vi.fn() }));
vi.mock("./header/header-proposals", () => ({ useProposalRequest: vi.fn() }));
vi.mock("./agent-state-store", () => ({ AgentStates: { getInstance: () => ({ blockAtom: vi.fn() }) } }));
vi.mock("./agent-hooks-store", async () => {
    const { atom } = await import("jotai");
    const service = {
        detailsAtom: () => atom(() => hookState.offer),
        visibleAtom: () => atom(() => hookState.offer),
        dismiss: hookState.dismiss,
        refresh: hookState.refresh,
        apply: hookState.apply,
        remove: hookState.remove,
        docPath: vi.fn(),
    };
    return { AgentHookOffers: { getInstance: () => service } };
});
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { settingsAtom: atom({}) } };
});
vi.mock("../command-panel/bindings", () => ({ writeSettings: vi.fn() }));

const English: Record<string, string> = {
    "agent.hooks.persistentTitle": "Manage {name} hooks",
    "agent.hooks.persistentSubtitle": "Persistent MoltenTerm lifecycle hooks",
    "agent.hooks.intro": "MoltenTerm reports {brings}.",
    "agent.hooks.exactFile": "Configuration file:",
    "agent.hooks.status.absent": "Hooks not configured",
    "agent.hooks.status.installed-not-reporting": "Hooks installed — restart Kimi Code to activate them",
    "agent.hooks.status.reporting": "Hooks active/reporting",
    "agent.hooks.status.definition-update": "MoltenTerm hook update available",
    "agent.hooks.status.drift": "Managed hooks need repair",
    "agent.hooks.status.compatibility-review": "Review Kimi Code compatibility",
    "agent.hooks.status.manual": "Manual configuration detected",
    "agent.hooks.status.invalid": "Hook configuration needs attention",
    "agent.hooks.status.conflict": "Conflicting hook configuration",
    "agent.hooks.explanation.absent": "Install the managed block after reviewing the target file.",
    "agent.hooks.explanation.installed-not-reporting": "The current Kimi Code process must be restarted.",
    "agent.hooks.explanation.reporting": "MoltenTerm is receiving hook reports.",
    "agent.hooks.explanation.definition-update": "Update MoltenTerm hooks to use the reviewed definition.",
    "agent.hooks.explanation.drift": "Repair the managed block without replacing your other settings.",
    "agent.hooks.explanation.compatibility-review":
        "This Kimi Code version is read-only until its hook contract is reviewed.",
    "agent.hooks.explanation.manual": "Your existing hooks are left unchanged.",
    "agent.hooks.explanation.invalid": "No managed write is allowed until the configuration is safe.",
    "agent.hooks.explanation.conflict": "Remove the conflicting duplicate before managing hooks.",
    "agent.hooks.qualifiedVersion": "Qualified Kimi Code version: {version}",
    "agent.hooks.currentVersion": "Current Kimi Code version: {version}",
    "agent.hooks.installedVersion": "Installed hook Kimi Code version: {version}",
    "agent.hooks.definitionVersion": "Hook definition: {version} (target {target})",
    "agent.hooks.eventCount": "{count} lifecycle events",
    "agent.hooks.backupNotice": "Before changing an existing file, MoltenTerm creates a backup.",
    "agent.hooks.persistentRestart": "The change applies from the next Kimi Code start.",
    "agent.hooks.manualFallback": "Copying TOML is a manual fallback and does not mark hooks installed or active.",
    "agent.hooks.install": "Install MoltenTerm hooks",
    "agent.hooks.update": "Update MoltenTerm hooks",
    "agent.hooks.repair": "Repair MoltenTerm hooks",
    "agent.hooks.review": "Review compatibility",
    "agent.hooks.manage": "Manage hooks",
    "agent.hooks.remove": "Remove MoltenTerm hooks",
    "agent.hooks.copy": "Copy TOML",
    "agent.hooks.copied": "Copied",
    "agent.hooks.dontOffer": "Don't offer again",
    "agent.hooks.guide": "Open the hook guide",
    "agent.hooks.error.invalid-toml": "The TOML is invalid; no changes were made.",
    "common.close": "Close",
    "companion.integration.persistentTitle": "Kimi Code hooks",
    "companion.integration.persistentHint": "Persistent hooks for {name}",
    "companion.history.back": "Back",
    "companion.integration.guide": "Integration guide",
};

vi.mock("./i18n/i18n", () => ({
    useT: () => (key: string, vars?: Record<string, unknown>) =>
        (English[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? `{${name}}`)),
}));

import { AgentHookOfferDialog } from "./agent-hooks-ui";
import { IntegrationDetails } from "./companion/companion-integration";
import type { CompanionView } from "./companion/companion-model";

function offer(fields: Partial<AgentHookOffer> = {}): AgentHookOffer {
    return {
        blockid: "block-kimi",
        agent: "kimi",
        agentname: "Kimi Code",
        show: true,
        file: "~/.kimi-code/config.toml",
        language: "toml",
        snippet: "[[hooks]]",
        persistent: true,
        status: "absent",
        action: "install",
        updatekey: "reviewed-revision",
        configdigest: "reviewed-digest",
        definitionversion: 1,
        definitionsha256: "definition-hash",
        qualifiedkimiversion: "2.6.3",
        currentkimiversion: "2.6.3",
        events: ["SessionStart"],
        canapply: true,
        ...fields,
    };
}

function dialog(fields: Partial<AgentHookOffer> = {}): string {
    return renderToStaticMarkup(
        <AgentHookOfferDialog blockId="block-kimi" offer={offer(fields)} onClose={vi.fn()} onDismiss={vi.fn()} />
    );
}

describe("the shared persistent hook approval dialog", () => {
    beforeEach(() => {
        hookState.offer = null;
        vi.clearAllMocks();
    });

    it("names the exact target, backup and next-start behavior before Install", () => {
        const html = dialog();
        expect(html).toContain("~/.kimi-code/config.toml");
        expect(html).toContain("Before changing an existing file, MoltenTerm creates a backup.");
        expect(html).toContain("The change applies from the next Kimi Code start.");
        expect(html).toContain("Install MoltenTerm hooks");
        expect(html).toContain("Qualified Kimi Code version: 2.6.3");
        expect(html).toContain('data-testid="agent-hooks-apply"');
        expect(html).not.toContain('data-testid="agent-hooks-remove"');
        expect(html).toContain("Copying TOML is a manual fallback and does not mark hooks installed or active.");
    });

    it("uses Update MoltenTerm hooks, never an application update, and retains Remove", () => {
        const html = dialog({
            status: "definition-update",
            action: "update",
            updatekind: "definition",
            installedkimiversion: "2.6.3",
            canremove: true,
        });
        expect(html).toContain("Update MoltenTerm hooks");
        expect(html).toContain("Remove MoltenTerm hooks");
        expect(html).not.toContain("Update Kimi");
    });

    it("makes compatibility review read-only while preserving safe removal", () => {
        const html = dialog({
            status: "compatibility-review",
            action: "review",
            updatekind: "compatibility",
            currentkimiversion: "2.7.0",
            installedkimiversion: "2.6.3",
            canapply: false,
            canremove: true,
        });
        expect(html).toContain("Review Kimi Code compatibility");
        expect(html).toContain("This Kimi Code version is read-only until its hook contract is reviewed.");
        expect(html).not.toContain('data-testid="agent-hooks-apply"');
        expect(html).toContain('data-testid="agent-hooks-remove"');
    });

    it("distinguishes restart-required, reporting and manual configuration without another Install", () => {
        const restart = dialog({
            status: "installed-not-reporting",
            action: "remove",
            canapply: false,
            canremove: true,
        });
        expect(restart).toContain("Hooks installed — restart Kimi Code to activate them");
        expect(restart).not.toContain('data-testid="agent-hooks-apply"');
        const active = dialog({ status: "reporting", action: "remove", canapply: false, canremove: true });
        expect(active).toContain("Hooks active/reporting");
        const manual = dialog({ status: "manual", managed: false, canapply: false, canremove: false });
        expect(manual).toContain("Manual configuration detected");
        expect(manual).not.toContain("Remove MoltenTerm hooks");
    });

    it("fails closed for invalid configuration", () => {
        const html = dialog({ status: "invalid", canapply: false, canremove: false, errorcode: "invalid-toml" });
        expect(html).toContain("The TOML is invalid; no changes were made.");
        expect(html).not.toContain('data-testid="agent-hooks-apply"');
        expect(html).not.toContain('data-testid="agent-hooks-remove"');
    });

    it("is also the Integration implementation when no command proposal is visible", () => {
        hookState.offer = offer({
            show: false,
            status: "reporting",
            action: "remove",
            canapply: false,
            canremove: true,
            managed: true,
        });
        const view = {
            blockid: "block-kimi",
            version: 1,
            status: "live",
            agent: "kimi",
            agentname: "Kimi Code",
            integration: null,
        } as CompanionView;
        const html = renderToStaticMarkup(<IntegrationDetails view={view} target="block-kimi" onClose={vi.fn()} />);
        expect(html).toContain('data-testid="companion-persistent-hooks"');
        expect(html).toContain("Hooks active/reporting");
        expect(html).toContain('data-testid="companion-persistent-manage"');
        expect(html).toContain('data-testid="companion-persistent-remove"');
        expect(html).not.toContain("companion-integration-turnoff-agent");
        expect(html).not.toContain("added to this run");
    });
});
