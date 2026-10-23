// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { parse } from "yaml";

const workflow = parse(await fs.readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const steps = (job) => workflow.jobs[job].steps;
const named = (job, name) => steps(job).find((step) => step.name === name);

test("public context reaches signing preflight, packaging, checksum policy and final publication", () => {
    for (const job of ["macos", "rehearsal", "publish"]) {
        for (const field of ["MODE", "CHANNEL", "VERSION"])
            assert.equal(
                workflow.jobs[job].env[`RELEASE_${field}`],
                `\${{ needs.meta.outputs.${field.toLowerCase()} }}`
            );
        for (const [field, source] of [
            ["SHA", "sha"],
            ["RUN_ID", "run_id"],
            ["RUN_ATTEMPT", "run_attempt"],
        ])
            assert.equal(workflow.jobs[job].env[`RELEASE_${field}`], `\${{ github.${source} }}`);
    }
    const mac = steps("macos");
    assert.ok(mac.indexOf(named("macos", "Signing mode")) < mac.findIndex((step) => step.run?.startsWith("npm ci")));
    assert.match(named("macos", "Signing mode").run, /node scripts\/release-policy\.mjs macos/);
    assert.match(named("meta", "Required checksum signing inputs").run, /release-policy\.mjs checksum-inputs/);
    assert.equal(named("meta", "Required checksum signing inputs").if, "github.event_name == 'push'");
    assert.ok(steps("macos").some((step) => step.with?.path?.includes("make/macos-verification.json")));
    assert.equal(
        named("publish", "Create or update the release").run,
        "node scripts/release-publish.mjs dist-release release-body.md"
    );
    assert.match(workflow.jobs.publish.env.MACOS_SIGNING, /needs.macos.outputs.signing/);
    assert.deepEqual(workflow.jobs.publish.needs, ["meta", "security", "macos", "linux"]);
    assert.equal(workflow.jobs.publish.if, "needs.meta.outputs.mode == 'release'");
    assert.ok(!steps("publish").some((step) => /gh release (create|upload|edit)/.test(step.run ?? "")));
});

test("pull requests execute portable delivery, policy, inventory and publication regressions", () => {
    assert.ok(workflow.on.pull_request.paths.includes("scripts/release-*.mjs"));
    const meta = steps("meta");
    const install = meta.findIndex((step) => step.run?.startsWith("npm ci --ignore-scripts"));
    for (const name of [
        "Test release admission and publication",
        "Test the release signing",
        "Test the macOS signing orchestration",
    ]) {
        assert.ok(install >= 0 && install < meta.indexOf(named("meta", name)));
        assert.equal(named("meta", name).if, "github.event_name == 'pull_request'");
    }
    assert.match(named("meta", "Test release admission and publication").run, /scripts\/release-\*\.node-test\.mjs/);
    assert.match(named("meta", "Test the macOS signing orchestration").run, /delivery\.node-test\.mjs/);
    assert.equal(workflow.jobs.macos.environment, "${{ needs.meta.outputs.mode == 'release' && 'release' || '' }}");
});
