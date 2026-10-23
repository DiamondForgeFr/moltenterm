// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { assertChecksumInputs, assertMacosPolicy, releasePolicy, validateContext } from "./release-policy.mjs";

test("all explicit channels and modes preserve rehearsal and RC policy", () => {
    for (const mode of ["check", "rehearsal", "release"])
        for (const channel of ["rc", "public"]) {
            const context = { mode, channel },
                mandatory = mode === "release" && channel === "public";
            assert.equal(releasePolicy(context).requireDeveloperId, mandatory);
            assert.equal(releasePolicy(context).requireChecksumSignature, mandatory);
            if (mandatory) {
                assert.throws(() => assertMacosPolicy(context, "adhoc"), /Public releases require/);
                assert.throws(() => assertChecksumInputs(context, {}), /requires/);
            } else {
                assert.doesNotThrow(() => assertMacosPolicy(context, "adhoc"));
                assert.equal(assertChecksumInputs(context, {}), false);
            }
            if (mode === "release") assert.doesNotThrow(() => assertMacosPolicy(context, "developer-id"));
            else assert.throws(() => assertMacosPolicy(context, "developer-id"), /must not receive/);
            for (let mask = 1; mask < 7; mask++)
                assert.throws(
                    () =>
                        assertChecksumInputs(context, {
                            publicKey: mask & 1,
                            privateKey: mask & 2,
                            passphrase: mask & 4,
                        }),
                    /requires/
                );
            assert.equal(
                assertChecksumInputs(context, { publicKey: true, privateKey: "fixture", passphrase: "fixture" }),
                true
            );
        }
});
test("unknown or absent context and signing values fail closed", () => {
    for (const context of [
        {},
        { mode: "release" },
        { mode: "public", channel: "public" },
        { mode: "release", channel: "stable" },
    ])
        assert.throws(() => releasePolicy(context), /Explicit release mode/);
    assert.throws(() => assertMacosPolicy({ mode: "release", channel: "public" }, "signed"), /Unknown/);
    assert.throws(() => validateContext({ mode: "release", channel: "public" }), /Invalid release/);
});
