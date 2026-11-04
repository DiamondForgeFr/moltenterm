// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release signature check against signatures made by gpg itself (a throwaway key, and the published v1.0.0-8
// release signed by the real release key: only its public key and signature are read), then against fake keys made
// on the spot for the cases gpg cannot be asked to produce.

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { dearmor, readReleaseKey, verifyDetachedSignature } from "./moltenterm-openpgp";
import { FakeKeyCreated, FakeSignedAt, makeFakeKey } from "./moltenterm-openpgp-testkit";

const Data = path.join(__dirname, "testdata", "openpgp");
const read = (...parts: string[]) => fs.readFileSync(path.join(Data, ...parts));
const text = (...parts: string[]) => read(...parts).toString("utf8");

describe("gpg interoperability", () => {
    it("verifies a signature made by gpg with a throwaway key", () => {
        const key = readReleaseKey(text("gpg-key-one.asc"));
        const result = verifyDetachedSignature(
            key,
            text("gpg-signed.txt.asc"),
            read("gpg-signed.txt"),
            Date.now() / 1000
        );
        expect(result.ok).toBe(true);
    });

    it("refuses that signature for a changed file and for another key", () => {
        const key = readReleaseKey(text("gpg-key-one.asc"));
        const now = Date.now() / 1000;
        expect(verifyDetachedSignature(key, text("gpg-signed.txt.asc"), Buffer.from("hello release!\n"), now)).toEqual({
            ok: false,
            reason: "bad",
        });
        const other = readReleaseKey(text("gpg-key-two.asc"));
        expect(verifyDetachedSignature(other, text("gpg-signed.txt.asc"), read("gpg-signed.txt"), now)).toEqual({
            ok: false,
            reason: "wrongkey",
        });
    });

    it("verifies the published v1.0.0-8 checksums against the release key", () => {
        const key = readReleaseKey(text("release-1.0.0-8", "release-signing-key.asc"));
        const result = verifyDetachedSignature(
            key,
            text("release-1.0.0-8", "SHA256SUMS.txt.asc"),
            read("release-1.0.0-8", "SHA256SUMS.txt"),
            Date.now() / 1000
        );
        expect(result.ok).toBe(true);
        const changed = Buffer.from(text("release-1.0.0-8", "SHA256SUMS.txt").replace("6feb", "6fec"));
        expect(
            verifyDetachedSignature(key, text("release-1.0.0-8", "SHA256SUMS.txt.asc"), changed, Date.now() / 1000)
        ).toEqual({
            ok: false,
            reason: "bad",
        });
    });

    it("reads the fingerprint RELEASE.md documents from the committed release key", () => {
        const committed = fs.readFileSync(path.join(__dirname, "..", "release-signing-key.asc"), "utf8");
        const key = readReleaseKey(committed);
        const docs = fs.readFileSync(path.join(__dirname, "..", "RELEASE.md"), "utf8").replace(/\s+/g, "");
        expect(docs).toContain(key.fingerprint);
        expect(key.keyId).toBe(key.fingerprint.slice(-16));
        expect(key.expiresAfter).toBeGreaterThan(0);
    });
});

describe("fake keys", () => {
    const data = Buffer.from("6feb  file.zip\n");
    const now = FakeSignedAt + 10;

    it("verifies what its own key signed, with each accepted hash", () => {
        const key = makeFakeKey();
        const read = readReleaseKey(key.armoredPublic);
        expect(read.fingerprint).toBe(key.fingerprint);
        for (const hash of ["sha256", "sha384", "sha512"] as const) {
            expect(verifyDetachedSignature(read, key.sign(data, { hash }), data, now).ok, hash).toBe(true);
        }
    });

    it("verifies signatures whose numbers start with zero bytes", () => {
        const key = makeFakeKey();
        const read = readReleaseKey(key.armoredPublic);
        for (let i = 0; i < 40; i++) {
            const d = Buffer.from(`line ${i}\n`);
            expect(verifyDetachedSignature(read, key.sign(d), d, now).ok, `${i}`).toBe(true);
        }
    });

    it("refuses a changed file, a signature by another key and a swapped signature", () => {
        const key = makeFakeKey();
        const other = makeFakeKey();
        const read = readReleaseKey(key.armoredPublic);
        expect(verifyDetachedSignature(read, key.sign(data), Buffer.from("other\n"), now)).toEqual({
            ok: false,
            reason: "bad",
        });
        expect(verifyDetachedSignature(read, other.sign(data), data, now)).toEqual({ ok: false, reason: "wrongkey" });
        const forged = other.sign(data, {
            issuerFingerprint: Buffer.from(key.fingerprint, "hex"),
            issuerKeyId: Buffer.from(key.keyId, "hex"),
        });
        expect(verifyDetachedSignature(read, forged, data, now)).toEqual({ ok: false, reason: "bad" });
    });

    it("refuses what it does not support instead of guessing", () => {
        const key = makeFakeKey();
        const read = readReleaseKey(key.armoredPublic);
        expect(verifyDetachedSignature(read, key.sign(data, { type: 1 }), data, now)).toEqual({
            ok: false,
            reason: "unsupported",
        });
        expect(verifyDetachedSignature(read, key.sign(data, { version: 3 }), data, now)).toEqual({
            ok: false,
            reason: "unsupported",
        });
        expect(verifyDetachedSignature(read, key.sign(data, { noCreated: true }), data, now)).toEqual({
            ok: false,
            reason: "unsupported",
        });
    });

    it("refuses a signature made before the key existed or after it expired, and an expired signature", () => {
        const lasting = makeFakeKey({ expiresAfter: 1000 });
        const read = readReleaseKey(lasting.armoredPublic);
        expect(read.expiresAfter).toBe(1000);
        expect(
            verifyDetachedSignature(read, lasting.sign(data, { signedAt: FakeKeyCreated + 500 }), data, now).ok
        ).toBe(true);
        expect(
            verifyDetachedSignature(read, lasting.sign(data, { signedAt: FakeKeyCreated + 1001 }), data, now)
        ).toEqual({
            ok: false,
            reason: "badtime",
        });
        expect(verifyDetachedSignature(read, lasting.sign(data, { signedAt: FakeKeyCreated - 1 }), data, now)).toEqual({
            ok: false,
            reason: "badtime",
        });
        const plain = readReleaseKey(makeFakeKey().armoredPublic);
        expect(plain.expiresAfter).toBeNull();
        const key = makeFakeKey();
        const signed = key.sign(data, { expiresAfter: 60 });
        expect(verifyDetachedSignature(readReleaseKey(key.armoredPublic), signed, data, FakeSignedAt + 30).ok).toBe(
            true
        );
        expect(verifyDetachedSignature(readReleaseKey(key.armoredPublic), signed, data, FakeSignedAt + 61)).toEqual({
            ok: false,
            reason: "expired",
        });
    });

    it("answers unreadable for anything that is not a signature", () => {
        const read = readReleaseKey(makeFakeKey().armoredPublic);
        for (const junk of ["", "hello", "-----BEGIN PGP SIGNATURE-----\n\n!!!\n-----END PGP SIGNATURE-----\n"]) {
            expect(verifyDetachedSignature(read, junk, data, now), junk).toEqual({ ok: false, reason: "unreadable" });
        }
        const truncated = makeFakeKey();
        const lines = truncated.sign(data).split("\n");
        const cut = [lines[0], "", lines[2].slice(0, 20), lines[lines.length - 2], ""].join("\n");
        expect(verifyDetachedSignature(read, cut, data, now).ok).toBe(false);
    });

    it("refuses a key that is not an Ed25519 version 4 public key", () => {
        expect(() => readReleaseKey("nothing")).toThrow();
        expect(() => readReleaseKey(text("gpg-signed.txt.asc"))).toThrow();
        expect(dearmor(text("gpg-key-one.asc")).length).toBeGreaterThan(40);
    });
});
