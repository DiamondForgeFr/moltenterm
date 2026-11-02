// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pour's stage and scenes, rendered without a window (FR-ONB-007 AC-1 to AC-5, P-1 to P-6, FR-ONB-009,
// TC-ONB-007, TC-ONB-012 to TC-ONB-014).

import { MoltentermMarkPath } from "@/util/moltenterm-identity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setTestMatrix } from "../moltenterm-shell/agent-info/agent-features-fixture";
import type { OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";
import { OnboardingPour, PourProps } from "./onboarding-pour";
import { FirstViewScene, PlaceScene, ProjectScene, ReadyScene } from "./onboarding-pour-build";

// The interface reads wavesrv's real compatibility matrix (FR-AGC-003).
setTestMatrix();

const noop = () => {};

function agent(id: string, name: string, executable: string, found: boolean): OnboardingAgent {
    return {
        id,
        name,
        executable,
        found,
        path: "",
        invocation: "/morph <request>",
        format: "skill",
        installed: found,
        guides: [],
        installpage: `https://example.invalid/${id}`,
    };
}

const Agents: OnboardingAgents = {
    version: "1.0.0",
    agents: [
        agent("claude-code", "Claude Code", "claude", true),
        agent("codex", "Codex", "codex", true),
        agent("gemini-cli", "Gemini CLI", "gemini", false),
        agent("qwen-code", "Qwen Code", "qwen", false),
        agent("kimi", "Kimi Code", "kimi", false),
    ],
};

const Ready = Agents.agents.filter((a) => a.found);
const Atlas = { name: "Atlas", colour: "#429DFF" };

function render(props: Partial<PourProps> = {}): string {
    return renderToStaticMarkup(
        <OnboardingPour
            reduced={false}
            busy={false}
            agents={Agents}
            checking={false}
            onRecord={noop}
            onCheckAgain={noop}
            onSkip={noop}
            onStart={noop}
            {...props}
        />
    );
}

describe("OnboardingPour (FR-ONB-007)", () => {
    it("frames the scene: six heat bars, Skip always there, no Back on the first scene", () => {
        const html = render();
        expect(html.match(/data-heat="/g)).toHaveLength(6);
        expect(html).toContain('data-heat="now"');
        expect(html).toContain('data-testid="first-run-skip"');
        expect(html).toContain("Skip, I&#x27;ll explore on my own");
        expect(html).not.toContain('data-testid="first-run-back"');
        expect(html).not.toContain('data-testid="first-run-later"');
        expect(html).toMatch(/class="molten-btn [^"]*"[^>]*data-testid="first-run-next"[^>]*>Light the forge/);
        expect(html).toContain("molten-btn-wave");
        expect(html).toContain("data-mt-dark-surface");
    });

    it("pours the real MoltenTerm mark, then the title and the four gestures", () => {
        const html = render();
        expect(html).toContain(`d="${MoltentermMarkPath}"`);
        expect(html).toContain("mt-pour-melt");
        expect(html).toContain("All your AI agents,");
        expect(html).toContain("one workshop.");
        expect(html).toContain("Claude Code, Codex and the others");
        expect(html).toContain("your agents, your project, your first view, its place.");
        expect(html).toContain('data-testid="first-run-about"');
    });

    it("shows Back from the second scene, Later on the project and the view only", () => {
        const project = render({ initialScene: 2 });
        expect(project).toContain('data-testid="first-run-back"');
        expect(project).toMatch(/data-testid="first-run-later"[^>]*>Later/);
        expect(project).toMatch(/data-testid="first-run-next"[^>]*>Compose my view/);
        expect(project.match(/data-heat="done"/g)).toHaveLength(2);
        expect(render({ initialScene: 3 })).toContain('data-testid="first-run-later"');
        expect(render({ initialScene: 4 })).not.toContain('data-testid="first-run-later"');
        expect(render({ initialScene: 1 })).toMatch(/data-testid="first-run-next"[^>]*>My project/);
    });

    it("marks reduced motion on the stage, so every scene shows at once", () => {
        expect(render({ reduced: true })).toContain("data-reduced");
        expect(render()).not.toContain("data-reduced");
    });

    it("does not leave the project scene before a folder is named or chosen", () => {
        expect(render({ initialScene: 2 })).toMatch(/aria-disabled="true"[^>]*data-testid="first-run-next"/);
    });

    it("ends on Enter the workshop, and says it opens it", () => {
        expect(render({ initialScene: 5 })).toMatch(/data-testid="first-run-next"[^>]*>Enter the workshop/);
        expect(render({ initialScene: 5, busy: true })).toContain("Opening your workshop…");
    });

    it("lists the agents from the detection, ready or not installed, with the plan recipes to configure", () => {
        const html = render({ initialScene: 1 });
        expect(html).toContain("MoltenTerm found 2 command-line agents on this computer.");
        expect(html).toMatch(/data-agent="claude-code" data-ready=""/);
        expect(html).toMatch(/data-agent="kimi">/);
        expect(html).toContain("$ claude");
        expect(html).toContain("$ kimi");
        // What works, from the matrix (FR-AGC-004), the same lines for every agent, the details closed.
        expect(html).toContain("MoltenTerm follows:</span> its state, approvals, and plan usage");
        expect(html).toContain("Not yet:</span> approvals, plan usage, and the browser");
        expect(html).toContain('data-testid="agent-works-toggle"');
        expect(html).not.toContain('data-testid="agent-works-details"');
        expect(html).toContain("Kimi subscription");
        expect(html).toContain("Not installed");
        expect(html).toContain('data-testid="pour-act-kimi"');
        // found, its sign-in not seen: the sign-in step (#1680)
        expect(html).toMatch(/data-testid="pour-act-claude-code"[^>]*>Sign in/);
        expect(html).toMatch(/data-testid="pour-act-glm"[^>]*>Configure/);
        expect(html).toMatch(/data-testid="pour-act-minimax"[^>]*>Configure/);
        expect(html).not.toContain('data-testid="pour-act-deepseek"');
        expect(html).toContain('data-testid="pour-codex-hooks"');
        expect(html).toContain("/hooks");
    });

    it("says so while it looks for the agents, and when it could not", () => {
        expect(render({ initialScene: 1, agents: null })).toContain("Looking for the command-line agents");
        const failed = render({ initialScene: 1, agents: null, agentsError: "The agents could not be listed: boom" });
        expect(failed).toContain("The agents could not be listed: boom");
    });

    it("says no agent is found yet, and every card can be installed", () => {
        const none = { version: "", agents: Agents.agents.map((a) => ({ ...a, found: false })) };
        const html = render({ initialScene: 1, agents: none });
        expect(html).toContain("MoltenTerm found no command-line agent on this computer yet.");
        expect(html).not.toContain("data-ready");
        expect(html).toContain('data-testid="pour-act-claude-code"');
    });

    it("shows a failure above the buttons", () => {
        expect(render({ error: "Could not start" })).toMatch(/role="alert"[^>]*>Could not start/);
    });
});

describe("the project scene (FR-ONB-007 P-4)", () => {
    const draft = { mode: "new" as const, name: "atlas", location: "/Users/ada/Projets", git: true, found: "" };
    const scene = (patch = {}, candidates = []) =>
        renderToStaticMarkup(
            <ProjectScene
                draft={{ ...draft, ...patch }}
                home="/Users/ada"
                candidates={candidates}
                scanning={false}
                now={Date.UTC(2026, 10, 1)}
                onPatch={noop}
                onChooseWhere={noop}
                onLookElsewhere={noop}
            />
        );

    it("creates a named folder where the user chooses, git checked, and names the folder it will make", () => {
        const html = scene();
        expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="pour-project-new"/);
        expect(html).toContain('value="atlas"');
        expect(html).toContain("~/Projets");
        expect(html).toContain('data-testid="pour-project-where"');
        expect(html).toMatch(/data-testid="pour-project-git" checked=""/);
        expect(html).toContain("~/Projets/atlas will be created, with git.");
        expect(html).toMatch(/data-testid="pour-project-chip"><i[^>]*><\/i>atlas/);
        expect(scene({ git: false })).toContain("~/Projets/atlas will be created.");
        expect(scene({ name: "" })).toContain("Name the folder first.");
    });

    it("lists the recent folders, then the repositories found, and offers another folder", () => {
        const candidates = [
            { path: "/Users/ada/Projets/billing", name: "billing", recent: true },
            { path: "/Users/ada/le-livre", name: "le-livre", modtime: Date.UTC(2026, 9, 30) },
        ];
        const html = scene({ mode: "find", found: "/Users/ada/le-livre" }, candidates);
        expect(html).toContain("~/Projets/billing");
        expect(html).toContain("recent");
        expect(html).toContain("repository · 2 days ago");
        expect(html).toMatch(/aria-pressed="true"[^>]*data-path="\/Users\/ada\/le-livre"/);
        expect(html).toContain('data-testid="pour-project-elsewhere"');
        expect(html).toMatch(/data-testid="pour-project-chip"><i[^>]*><\/i>le-livre/);
    });
});

describe("the first view (FR-ONB-009)", () => {
    const view = (props = {}) =>
        renderToStaticMarkup(
            <FirstViewScene
                tools={["browser", "files"]}
                name="Scoping"
                named={false}
                agents={Ready}
                agentId="codex"
                project={Atlas}
                reduced={false}
                onTool={noop}
                onPreset={noop}
                onName={noop}
                onAgent={noop}
                {...props}
            />
        );

    it("offers the agents found, the four tools, the five suggestions and the name", () => {
        const html = view();
        expect(html.match(/data-agent="/g)).toHaveLength(2);
        expect(html).toMatch(/aria-pressed="true"[^>]*data-agent="codex"/);
        expect(html.match(/data-tool="/g)).toHaveLength(4);
        expect(html).toMatch(/aria-pressed="true"[^>]*data-tool="browser"/);
        expect(html).toMatch(/aria-pressed="false"[^>]*data-tool="integration"/);
        expect(html.match(/data-preset="/g)).toHaveLength(5);
        expect(html).toMatch(/aria-pressed="true"[^>]*data-preset="scoping"/);
        expect(html).toContain('value="Scoping"');
    });

    it("assembles the view live: the agent's place starts nothing, the tools pour in on the right", () => {
        const html = view();
        expect(html).toMatch(/data-testid="pour-view-start">Start Codex/);
        expect(html.match(/data-panel="/g)).toHaveLength(2);
        expect(html).toContain("data-pour");
        expect(html).toContain("Top row · empty");
        expect(view({ tools: [] })).toContain("Just the agent. Add a tool on the left.");
    });

    it("shows a single agent as it is, and waits for one when none is found", () => {
        expect(view({ agents: Ready.slice(0, 1), agentId: "claude-code" })).not.toContain("data-agent=");
        const none = view({ agents: [], agentId: null });
        expect(none).toContain("An agent, to choose later");
        expect(none).toMatch(/data-testid="pour-view-start">Start an agent/);
    });
});

describe("its place (FR-ONB-009)", () => {
    const place = (p: "everywhere" | "workspace") =>
        renderToStaticMarkup(<PlaceScene name="Scoping" place={p} project={Atlas} onPlace={noop} />);

    it("offers every workspace first, worded for the workshop, with everything changeable later", () => {
        const html = place("everywhere");
        expect(html).toMatch(/aria-pressed="true"[^>]*data-place="everywhere"/);
        expect(html).toContain("Available in all your workspaces, including the next ones");
        expect(html).toContain("Pinned in Atlas only");
        expect(html).toContain("Everything can be changed later.");
        expect(html.match(/class="mt-pb-mine"/g)).toHaveLength(2);
    });

    it("pinned in the workspace, makes a tile of this workspace only", () => {
        const html = place("workspace");
        expect(html).toMatch(/aria-pressed="true"[^>]*data-place="workspace"/);
        expect(html.match(/mt-pb-mine/g)).toHaveLength(1);
        expect(html).toContain("Scoping becomes a tile of Atlas.");
    });
});

describe("ready (FR-ONB-007 P-6)", () => {
    const ready = (recap: any) => renderToStaticMarkup(<ReadyScene markPath={MoltentermMarkPath} recap={recap} />);

    it("recaps the project, the view and its place, then /morph and the next views", () => {
        const html = ready({
            project: { name: "Atlas", path: "~/Projets/atlas", colour: "#429DFF" },
            view: { name: "Scoping", parts: "Codex · Web page · Files" },
            place: "everywhere",
            workspace: "Atlas",
        });
        expect(html).toContain("~/Projets/atlas");
        expect(html).toContain("Codex · Web page · Files");
        expect(html).toContain("Available in all your workspaces");
        expect(html).toContain("<code");
        expect(html).toContain("/morph");
        expect(html).toContain("Your next views:");
        expect(html).toContain("<kbd>");
        expect(html).toContain("Everyone organises it their own way!");
    });

    it("says what was left for later", () => {
        const html = ready({ project: null, view: null, place: "everywhere", workspace: "My workspace" });
        expect(html).toContain("A workspace without a project");
        expect(html).toContain("No view yet");
    });
});
