// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeployConfirmBody, DeployMenuView, requestDeploy } from "./deploy-menu";
import { DeployTarget } from "./deploy-model";

const dev: DeployTarget = {
    environment: "dev",
    stepId: "deploy-dev",
    title: "Deploy to ofpis-dev",
    confirm: false,
    last: null,
};
const prod: DeployTarget = {
    environment: "prod",
    stepId: "deploy-prod",
    title: "Deploy to prod",
    confirm: true,
    last: null,
};

function render(targets: DeployTarget[], busy = false): string {
    return renderToStaticMarkup(
        <DeployMenuView
            targets={targets}
            busy={busy}
            open={false}
            setOpen={() => {}}
            onChoose={() => {}}
            onShowRun={() => {}}
        />
    );
}

describe("Deploy to (#559)", () => {
    it("shows nothing when no step names an environment", () => {
        expect(render([])).toBe("");
    });

    it("offers a single environment directly", () => {
        const html = render([dev]);
        expect(html).toContain("Deploy to dev");
        expect(html).not.toContain("aria-expanded");
    });

    it("opens a menu for several environments", () => {
        const html = render([dev, prod]);
        expect(html).toContain("Deploy to…");
        expect(html).toContain('aria-expanded="false"');
    });

    it("says which environment a deploy under way goes to", () => {
        const running = {
            ...dev,
            last: {
                id: "r",
                dir: "/p",
                kind: "step",
                stepid: "deploy-dev",
                command: "true",
                startedat: 1,
                state: "running" as const,
                phases: [],
                logsize: 0,
            },
        };
        expect(render([running, prod])).toContain("Deploying to dev…");
    });

    it("is held while another step runs", () => {
        expect(render([dev], true)).toContain("disabled");
    });

    it("runs a plain environment at once and asks first for production, with a fake runner", () => {
        const ran: string[] = [];
        const asked: string[] = [];
        requestDeploy(
            dev,
            (id) => ran.push(id),
            (t) => asked.push(t.environment)
        );
        requestDeploy(
            prod,
            (id) => ran.push(id),
            (t) => asked.push(t.environment)
        );
        expect(ran).toEqual(["deploy-dev"]);
        expect(asked).toEqual(["prod"]);
    });

    it("names the environment and what is deployed in the confirmation", () => {
        const html = renderToStaticMarkup(
            <DeployConfirmBody target={prod} revision={{ branch: "develop", commit: "abcdef1" }} />
        );
        expect(html).toContain("develop at abcdef1");
        expect(html).toContain("prod");
        expect(html).toContain("named like production");
    });
});
