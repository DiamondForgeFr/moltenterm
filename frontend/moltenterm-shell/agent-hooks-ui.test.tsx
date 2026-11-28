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
    "agent.hooks.title": "Precise states for {name}",
    "agent.hooks.subtitle": "MoltenTerm only changes your agent's settings when you apply, after a backup.",
    "agent.hooks.intro": "MoltenTerm reports {brings}.",
    "agent.hooks.exactFile": "Configuration file:",
    "agent.hooks.status.absent": "Hooks not configured",
    "agent.hooks.status.installed-not-reporting": "Hooks installed — restart {name} to activate them",
    "agent.hooks.status.reporting": "Hooks active/reporting",
    "agent.hooks.status.definition-update": "MoltenTerm hook update available",
    "agent.hooks.status.drift": "Managed hooks need repair",
    "agent.hooks.status.compatibility-review": "Review {name} compatibility",
    "agent.hooks.status.manual": "Manual configuration detected",
    "agent.hooks.status.invalid": "Hook configuration needs attention",
    "agent.hooks.status.conflict": "Conflicting hook configuration",
    "agent.hooks.explanation.absent": "Install the managed block after reviewing the target file.",
    "agent.hooks.explanation.installed-not-reporting": "The {name} running now must be restarted.",
    "agent.hooks.explanation.reporting": "MoltenTerm is receiving hook reports.",
    "agent.hooks.explanation.definition-update": "Update MoltenTerm hooks to use the reviewed definition.",
    "agent.hooks.explanation.drift": "Repair the managed block without replacing your other settings.",
    "agent.hooks.explanation.compatibility-review":
        "This {name} version is read-only until its hook contract is reviewed.",
    "agent.hooks.explanation.manual": "Your existing hooks are left unchanged.",
    "agent.hooks.explanation.invalid": "No managed write is allowed until the configuration is safe.",
    "agent.hooks.explanation.conflict": "Remove the conflicting duplicate before managing hooks.",
    "agent.hooks.qualifiedVersion": "Qualified {name} version: {version}",
    "agent.hooks.currentVersion": "Current {name} version: {version}",
    "agent.hooks.installedVersion": "Installed hook {name} version: {version}",
    "agent.hooks.definitionVersion": "Hook definition: {version} (target {target})",
    "agent.hooks.eventCount": "{count} lifecycle events",
    "agent.hooks.backupNotice": "Before changing an existing file, MoltenTerm creates a backup.",
    "agent.hooks.backupCreated": "Backup created:",
    "agent.hooks.persistentRestart": "The change applies from the next {name} start.",
    "agent.hooks.trustAfterApply": "{name} runs new hooks only once you trust them in its /hooks.",
    "agent.hooks.launcherAlso": "Sessions MoltenTerm starts already get its current hooks.",
    "agent.hooks.manualFallback": "To add it yourself instead, copy the snippet below into this file, {also}.",
    "agent.hooks.alsoBy.claude": "or in a project's .claude/settings.json",
    "agent.hooks.install": "Apply",
    "agent.hooks.update": "Apply the update",
    "agent.hooks.repair": "Apply the repair",
    "agent.hooks.review": "Review compatibility",
    "agent.hooks.manage": "Manage hooks",
    "agent.hooks.remove": "Remove MoltenTerm hooks",
    "agent.hooks.copy": "Copy",
    "agent.hooks.copied": "Copied",
    "agent.hooks.dontOffer": "Don't offer again",
    "agent.hooks.guide": "Open the hook guide",
    "agent.hooks.error.invalid-toml": "The TOML is invalid; no changes were made.",
    "agent.hooks.error.invalid-json": "The JSON is invalid; no changes were made.",
    "agent.hooks.changes.title": "What changes",
    "agent.hooks.changes.added": "Added",
    "agent.hooks.changes.removed": "Removed",
    "agent.hooks.changes.default": "default",
    "agent.hooks.changes.none": "none",
    "agent.hooks.changes.seconds": "{value} s",
    "agent.hooks.changes.field.command": "Command",
    "agent.hooks.changes.field.timeout": "Timeout",
    "agent.hooks.changes.field.qualifiedversion": "Qualified {name} version",
    "agent.hooks.changes.field.duplicate": "Runs MoltenTerm's hook more than once",
    "agent.hooks.unqualified.title": "Version not qualified yet",
    "agent.hooks.unqualified.body":
        "MoltenTerm has not yet checked the hook contract of {name} {version} (qualified version: {qualified}).",
    "agent.hooks.unqualified.risk": "If the contract changed, the hooks may not fire.",
    "agent.hooks.unqualified.ask": "Write MoltenTerm's hooks for this version anyway?",
    "agent.hooks.unqualified.confirm": "Confirm and write",
    "common.cancel": "Cancel",
    "common.close": "Close",
    "companion.integration.persistentTitle": "Agent hooks",
    "companion.integration.persistentHint": "Persistent hooks for {name}",
    "companion.history.back": "Back",
    "companion.integration.guide": "Integration guide",
};

vi.mock("./i18n/i18n", () => ({
    useT: () => (key: string, vars?: Record<string, unknown>) =>
        (English[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? `{${name}}`)),
}));

import { AgentHookOfferDialog, HookConfirmButtons } from "./agent-hooks-ui";
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

function claudeUpdate(fields: Partial<AgentHookOffer> = {}): Partial<AgentHookOffer> {
    return {
        blockid: "block-claude",
        agent: "claude",
        agentname: "Claude Code",
        file: "~/.claude/settings.json",
        language: "json",
        status: "definition-update",
        action: "update",
        updatekind: "definition",
        canapply: true,
        canremove: true,
        definitionversion: undefined,
        definitionsha256: undefined,
        qualifiedkimiversion: undefined,
        currentkimiversion: undefined,
        changes: [{ kind: "changed", event: "Stop", field: "command", installed: "old", available: "new" }],
        ...fields,
    };
}

describe("the shared persistent hook approval dialog", () => {
    beforeEach(() => {
        hookState.offer = null;
        vi.clearAllMocks();
    });

    it("names the exact target, backup and next-start behavior before Apply", () => {
        const html = dialog();
        expect(html).toContain("~/.kimi-code/config.toml");
        expect(html).toContain("Before changing an existing file, MoltenTerm creates a backup.");
        expect(html).toContain("The change applies from the next Kimi Code start.");
        expect(html).toContain("Apply");
        expect(html).toContain("Qualified Kimi Code version: 2.6.3");
        expect(html).toContain('data-testid="agent-hooks-apply"');
        expect(html).not.toContain('data-testid="agent-hooks-remove"');
        expect(html).toContain("To add it yourself instead, copy the snippet below into this file");
        expect(html).toContain("MoltenTerm only changes your agent&#x27;s settings when you apply, after a backup.");
        expect(html).not.toContain("never");
    });

    it("applies the update of MoltenTerm's hooks, never an application update, and retains Remove", () => {
        const html = dialog({
            status: "definition-update",
            action: "update",
            updatekind: "definition",
            installedkimiversion: "2.6.3",
            canremove: true,
        });
        expect(html).toContain("Apply the update");
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

    // #2543: hooks installed for 2.6.3 while Kimi Code runs 2.7.2, the qualified version.
    it("shows what differs and offers the update when installed and available hooks differ", () => {
        const html = dialog({
            status: "definition-update",
            action: "update",
            updatekind: "definition",
            qualifiedkimiversion: "2.7.2",
            currentkimiversion: "2.7.2",
            installedkimiversion: "2.6.3",
            canremove: true,
            changes: [
                { kind: "changed", field: "qualifiedversion", installed: "2.6.3", available: "2.7.2" },
                { kind: "changed", event: "Stop", field: "timeout", installed: "10", available: "15" },
                { kind: "added", event: "Interrupt" },
            ],
        });
        expect(html).toContain("What changes");
        expect(html).toContain("Qualified Kimi Code version");
        expect(html).toContain("2.6.3");
        expect(html).toContain("10 s");
        expect(html).toContain("15 s");
        expect(html).toContain("Interrupt");
        expect(html).toContain("Added");
        expect(html.match(/data-testid="agent-hooks-change"/g)).toHaveLength(3);
        expect(html).toContain('data-testid="agent-hooks-apply"');
        expect(html).toContain("Apply the update");
        expect(html).not.toContain('data-testid="agent-hooks-unqualified"');
    });

    it("says an unqualified newer version is not checked yet, and still offers the update", () => {
        const html = dialog({
            status: "definition-update",
            action: "update",
            updatekind: "definition",
            qualifiedkimiversion: "2.7.2",
            currentkimiversion: "2.9.0",
            unqualified: true,
            changes: [{ kind: "changed", event: "Stop", field: "timeout", installed: "10", available: "15" }],
        });
        expect(html).toContain('data-testid="agent-hooks-unqualified"');
        expect(html).toContain(
            "MoltenTerm has not yet checked the hook contract of Kimi Code 2.9.0 (qualified version: 2.7.2)."
        );
        expect(html).toContain('data-testid="agent-hooks-apply"');
        expect(html).not.toContain("read-only");
    });

    it("asks before writing an unqualified version, and Confirm writes", () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        const t = (key: string) => English[key] ?? key;
        const html = renderToStaticMarkup(
            <HookConfirmButtons busy={false} onCancel={onCancel} onConfirm={onConfirm} t={t} />
        );
        expect(html).toContain("Write MoltenTerm&#x27;s hooks for this version anyway?");
        expect(html).toContain("Confirm and write");
        expect(html).toContain("Cancel");
        const element = HookConfirmButtons({ busy: false, onCancel, onConfirm, t });
        const confirm = (element.props.children as any[]).find(
            (c) => c?.props?.["data-testid"] === "agent-hooks-confirm"
        );
        confirm.props.onClick();
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
    });

    // #2595: the Claude Code update the developer met in the gold, now applied from the dialog.
    it("applies a Claude Code user file's older hooks, with the diff and Copy kept", () => {
        const html = dialog(claudeUpdate());
        expect(html).toContain("Precise states for Claude Code");
        expect(html).toContain("~/.claude/settings.json");
        expect(html).toContain('data-testid="agent-hooks-changes"');
        expect(html).toContain('data-testid="agent-hooks-apply"');
        expect(html).toContain("Apply the update");
        expect(html).toContain("Copy");
        expect(html).toContain("Before changing an existing file, MoltenTerm creates a backup.");
        expect(html).toContain("or in a project&#x27;s .claude/settings.json");
        expect(html).not.toContain("Qualified");
        expect(html).not.toContain('data-testid="agent-hooks-trust"');
    });

    it("says the launcher's hooks run next to the older ones on a launched run", () => {
        expect(dialog(claudeUpdate({ launcheralso: true }))).toContain('data-testid="agent-hooks-launcher-also"');
        expect(dialog(claudeUpdate())).not.toContain('data-testid="agent-hooks-launcher-also"');
    });

    it("says when the agent asks to trust new hooks, as data from wavesrv", () => {
        const html = dialog(
            claudeUpdate({ agent: "codex", agentname: "Codex", file: "~/.codex/hooks.json", trustrequired: true })
        );
        expect(html).toContain("Codex runs new hooks only once you trust them in its /hooks.");
    });

    it("lists a doubled MoltenTerm hook as a change", () => {
        const html = dialog(claudeUpdate({ changes: [{ kind: "changed", event: "Stop", field: "duplicate" }] }));
        expect(html).toContain("Runs MoltenTerm&#x27;s hook more than once");
    });

    // The common floor: the same state shows the same controls whatever the provider.
    it("gives every provider the same controls for the same state", () => {
        const providers: Partial<AgentHookOffer>[] = [
            { agent: "claude", agentname: "Claude Code", file: "~/.claude/settings.json", language: "json" },
            { agent: "codex", agentname: "Codex", file: "~/.codex/hooks.json", language: "json" },
            { agent: "kimi", agentname: "Kimi Code", file: "~/.kimi-code/config.toml", language: "toml" },
        ];
        const states: Partial<AgentHookOffer>[] = [
            { status: "absent", action: "install", canapply: true },
            {
                status: "definition-update",
                action: "update",
                updatekind: "definition",
                canapply: true,
                canremove: true,
            },
            { status: "installed-not-reporting", action: "remove", canapply: false, canremove: true },
            { status: "invalid", canapply: false, canremove: false, errorcode: "read-config" },
            { status: "absent", action: "install", canapply: true, unqualified: true },
        ];
        const controls = (html: string) =>
            [...html.matchAll(/data-testid="(agent-hooks-[a-z-]+)"/g)]
                .map((m) => m[1])
                .filter((id) => id !== "agent-hooks-change");
        for (const state of states) {
            const seen = providers.map((p) =>
                controls(dialog({ qualifiedkimiversion: undefined, currentkimiversion: undefined, ...p, ...state }))
            );
            expect(seen[1]).toEqual(seen[0]);
            expect(seen[2]).toEqual(seen[0]);
        }
    });

    it("offers no update when nothing differs", () => {
        const html = dialog({
            status: "reporting",
            action: "remove",
            canapply: false,
            canremove: true,
            unqualified: false,
        });
        expect(html).not.toContain('data-testid="agent-hooks-changes"');
        expect(html).not.toContain('data-testid="agent-hooks-apply"');
        expect(html).not.toContain('data-testid="agent-hooks-unqualified"');
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
