// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A release cut end to end (#230): the Timeline's sequencing (releaseRun) picks every step, and the real runner
// (pkg/molten/mission, through its TestReleaseDriver) runs it on a throwaway Notulia-shaped fixture whose origin is a
// local bare repository. It builds the Go test binary, so it runs only with MOLTEN_RELEASE_E2E=1:
//     MOLTEN_RELEASE_E2E=1 npx vitest run frontend/moltenterm-shell/mission/release-e2e.test.ts

import { ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { beforeAll, describe, expect, it } from "vitest";
import { PipelineDef, PipelineReleaseStep } from "./mission-model";
import { ReleaseChannel } from "./release-model";
import { PhaseAction, PreparationStep, ReleaseFacts, releaseRun } from "./release-run";

const Enabled = process.env.MOLTEN_RELEASE_E2E === "1";
const Root = path.resolve(__dirname, "../../..");
const MissionDir = path.join(Root, "pkg", "molten", "mission");
const DriverPrefix = "DRIVER ";

type Answer = {
    error?: string;
    dir?: string;
    pipeline?: PipelineDef;
    facts?: ReleaseFacts;
    run?: { stepid: string; state: string };
    log?: string;
    notes?: string;
};

class Driver {
    proc: ChildProcessWithoutNullStreams;
    waiting: ((a: Answer) => void)[] = [];
    output: string[] = [];

    constructor(binary: string) {
        this.proc = spawn(binary, ["-test.run", "^TestReleaseDriver$", "-test.timeout", "10m"], {
            cwd: MissionDir,
            env: { ...process.env, MOLTEN_RELEASE_DRIVER: "1" },
        });
        createInterface({ input: this.proc.stdout }).on("line", (line) => {
            if (!line.startsWith(DriverPrefix)) {
                this.output.push(line);
                return;
            }
            this.waiting.shift()?.(JSON.parse(line.slice(DriverPrefix.length)));
        });
        this.proc.stderr.on("data", (d) => this.output.push(String(d)));
    }

    ask(req: Record<string, string>): Promise<Answer> {
        return new Promise((resolve, reject) => {
            this.waiting.push((a) => (a.error ? reject(new Error(`${req.op}: ${a.error}`)) : resolve(a)));
            this.proc.stdin.write(JSON.stringify(req) + "\n");
        });
    }

    quit() {
        this.proc.stdin.write(JSON.stringify({ op: "quit" }) + "\n");
    }
}

let binary: string;

// Follows one release as a person would on the Timeline: always the current phase's action, confirmed when it asks,
// the notes read and edited before the cut. Returns the steps run, in order.
async function followRelease(
    driver: Driver,
    steps: PipelineReleaseStep[],
    channel: ReleaseChannel,
    tag: string
): Promise<string[]> {
    const ran: string[] = [];
    const start = await driver.ask({ op: "start", channel, tag });
    ran.push(`${PreparationStep}:${start.run.state}`);
    for (let i = 0; i < 20; i++) {
        const { facts } = await driver.ask({ op: "facts" });
        const run = releaseRun(facts, steps);
        if (!run.active) {
            expect(run.phases.map((p) => p.status)).toEqual(["done", "done", "done", "done", "done"]);
            await driver.ask({ op: "end" });
            return ran;
        }
        const phase = run.phases.find((p) => p.id === run.current);
        const action: PhaseAction = phase.action;
        if (action == null || action.kind === "rerun") {
            throw new Error(`stuck in ${phase.id}: ${phase.status}, ${phase.expect} ${phase.cause ?? ""}`);
        }
        if (action.kind === "step" && action.step === "finalize") {
            // The cut that pushes the tag: confirmed, and its notes offered for editing first.
            expect(action.confirm).toContain(tag);
            expect(run.editNotes).toBe(true);
            const { notes } = await driver.ask({ op: "notes", tag });
            expect(notes).toContain(tag);
            await driver.ask({ op: "savenotes", tag, text: `${notes}\nRead and edited on the Timeline.` });
        }
        const step = action.kind === "prepare" ? PreparationStep : action.step;
        const done = await driver.ask({ op: "step", tag, step });
        ran.push(`${step}:${done.run.state}`);
        if (done.run.state !== "success") {
            throw new Error(`${step} failed:\n${done.log}`);
        }
    }
    throw new Error("the release did not end in 20 steps");
}

describe.skipIf(!Enabled)("a Notulia-shaped release, end to end (#230)", () => {
    beforeAll(() => {
        binary = path.join(mkdtempSync(path.join(tmpdir(), "mt230-driver-")), "mission.test");
        execFileSync("go", ["test", "-c", "-o", binary, "./pkg/molten/mission"], { cwd: Root, stdio: "inherit" });
    }, 300_000);

    for (const variant of ["unphased", "phased"]) {
        it(`cuts a release candidate, then a public release (${variant})`, async () => {
            const driver = new Driver(binary);
            try {
                const { pipeline } = await driver.ask({ op: "fixture", variant });
                const middle =
                    variant === "phased" ? ["prepare", "finalize", "verify"] : ["promote", "prepare", "finalize"];
                const expected = [`${PreparationStep}:success`, ...[...middle, "sync-back"].map((s) => `${s}:success`)];
                expect(await followRelease(driver, pipeline.release.rc, "rc", "v1.0.0-1")).toEqual(expected);
                await new Promise((r) => setTimeout(r, 1100));
                expect(await followRelease(driver, pipeline.release.public, "public", "v1.0.0")).toEqual(expected);
            } finally {
                driver.quit();
            }
        }, 120_000);
    }

    it("offers the failed cut again, and the step before it", async () => {
        const driver = new Driver(binary);
        try {
            const { pipeline } = await driver.ask({ op: "fixture", variant: "unphased" });
            const steps = pipeline.release.rc;
            const tag = "v1.0.0-1";
            await driver.ask({ op: "start", channel: "rc", tag });
            await driver.ask({ op: "step", tag, step: "promote" });
            await driver.ask({ op: "step", tag, step: "prepare" });
            await driver.ask({ op: "fail", step: "finalize" });
            const failed = await driver.ask({ op: "step", tag, step: "finalize" });
            expect(failed.run.state).toBe("failure");
            const { facts } = await driver.ask({ op: "facts" });
            const cut = releaseRun(facts, steps).phases[1];
            expect(cut).toMatchObject({
                status: "failed",
                action: { kind: "step", step: "finalize" },
                redo: { kind: "step", step: "prepare" },
            });
            expect(cut.cause).toContain("finalize failed, as asked");
            const redo = await driver.ask({ op: "step", tag, step: "prepare" });
            expect(redo.run.state).toBe("success");
            const again = await driver.ask({ op: "step", tag, step: "finalize" });
            expect(again.run.state).toBe("success");
            const after = releaseRun((await driver.ask({ op: "facts" })).facts, steps);
            expect(after.phases[1].status).toBe("done");
            expect(after.phases[4]).toMatchObject({ action: { kind: "step", step: "sync-back" } });
        } finally {
            driver.quit();
        }
    }, 120_000);
});
