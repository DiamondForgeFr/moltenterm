#!/usr/bin/env node
// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

// Developer ID probe helpers (#880), used by .github/workflows/macos-signing-probe.yml around the real package.mjs run.
// The release path reports a failed session only as "Signing session failed"; these stages name the check that failed
// (never a value), and read back Apple's notarization record as evidence.
//
//   node scripts/macos-signing/probe.mjs preflight          input shapes, keychain import, identity, notary API key
//   node scripts/macos-signing/probe.mjs history <since>    notarization submissions created at or after <since> (ISO)

/* global console */

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { signingInputs } from "./policy.mjs";
import { command, withSigningSession } from "./session.mjs";

const HistoryFields = ["id", "name", "status", "createdDate"];

// Records which Apple tool subcommand failed: its name is fixed text, its arguments may hold credentials.
function tracingRun(trace) {
    return async (file, args, options) => {
        const stage = `${path.basename(file)} ${args[0] ?? ""}`.trim();
        try {
            return await command(file, args, options);
        } catch (error) {
            trace.failed ??= stage;
            throw error;
        }
    };
}

async function notaryHistory(apiKey, inputs, run) {
    const output = await run("/usr/bin/xcrun", [
        "notarytool",
        "history",
        "--key",
        apiKey,
        "--key-id",
        inputs.keyId,
        "--issuer",
        inputs.issuer,
        "--output-format",
        "json",
    ]);
    const parsed = JSON.parse(output.stdout);
    if (!parsed || !Array.isArray(parsed.history)) throw new Error("Unexpected notarytool history output");
    return parsed.history.map((entry) => Object.fromEntries(HistoryFields.map((field) => [field, entry?.[field]])));
}

async function inSession(label, body) {
    // Without a failed command, the session failed on its identity check, or the body on Apple's output.
    const trace = { phase: "the identity check" };
    const run = tracingRun(trace);
    try {
        return await withSigningSession(
            process.env,
            (session) => {
                trace.phase = "reading notarytool's output";
                return body(session, run);
            },
            { run }
        );
    } catch {
        throw new Error(`${label} failed at: ${trace.failed ?? trace.phase}`);
    }
}

export async function preflight(log = (message) => console.log(message)) {
    try {
        signingInputs(process.env);
    } catch (error) {
        // policy.mjs messages name the input, never its value.
        throw new Error(`Signing inputs: ${error.message}`);
    }
    log("Signing inputs: all seven present, shapes valid");
    const entries = await inSession("Keychain and notary preflight", async ({ inputs, apiKey }, run) => {
        log("Keychain: Developer ID Application identity imported, fingerprint and team match");
        return notaryHistory(apiKey, inputs, run);
    });
    log(`Notary API key: accepted by Apple (${entries.length} earlier submissions visible)`);
    // Apple can keep a team's first submissions In Progress for hours: show where the earlier ones stand.
    for (const entry of entries.slice(0, 10))
        log(`  ${entry.id}  ${entry.status}  ${entry.createdDate}  ${entry.name}`);
}

export async function history(since, log = (message) => console.log(message)) {
    const from = Date.parse(since);
    if (Number.isNaN(from)) throw new Error("usage: probe.mjs history <ISO date>");
    const entries = await inSession("Notarization history", ({ inputs, apiKey }, run) =>
        notaryHistory(apiKey, inputs, run)
    );
    const recent = entries.filter((entry) => Date.parse(entry.createdDate) >= from);
    for (const entry of recent) log(`${entry.id}  ${entry.status}  ${entry.createdDate}  ${entry.name}`);
    if (!recent.length) throw new Error("No notarization submission since the probe started");
    if (recent.some((entry) => entry.status !== "Accepted")) throw new Error("A probe submission is not Accepted");
}

async function main([action, ...rest]) {
    if (action === "preflight") return preflight();
    if (action === "history") return history(rest[0]);
    throw new Error("usage: probe.mjs preflight | history <ISO date>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(`::error::${error.message}`);
        process.exitCode = 1;
    });
}
