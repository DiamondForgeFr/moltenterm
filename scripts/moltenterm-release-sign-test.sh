#!/usr/bin/env bash
# Copyright 2026, DiamondForge
# SPDX-License-Identifier: Apache-2.0
#
# Tests scripts/moltenterm-release-sign.sh with a throwaway key generated here, in a temporary GNUPGHOME, and deleted
# afterwards: never the release key. Run by .github/workflows/release.yml on the pull requests that change the signing
# (#576), and by hand with gpg installed.
#
# usage: scripts/moltenterm-release-sign-test.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
sign="$root/scripts/moltenterm-release-sign.sh"
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/mt-gpg-test.XXXXXX")"
cleanup() {
    for home in "$work"/keys "$work"/other "$work"/user; do
        if [ -d "$home" ]; then
            GNUPGHOME="$home" gpgconf --kill all > /dev/null 2>&1 || true
        fi
    done
    rm -rf "$work"
}
trap cleanup EXIT

failures=0
pass() { echo "ok: $1"; }
fail() {
    echo "FAILED: $1"
    failures=$((failures + 1))
}

# A throwaway key in its own GNUPGHOME, exported as the two secrets and the public key would be.
make_key() {
    local home="$1" passphrase="$2"
    mkdir -m 700 "$home"
    GNUPGHOME="$home" gpg --batch --quiet --pinentry-mode loopback --passphrase "$passphrase" \
        --quick-generate-key "MoltenTerm sign test <sign-test@example.invalid>" ed25519 sign 1d 2> /dev/null
    GNUPGHOME="$home" gpg --batch --quiet --armor --export > "$home/public.asc"
    GNUPGHOME="$home" gpg --batch --quiet --pinentry-mode loopback --passphrase "$passphrase" \
        --armor --export-secret-keys > "$home/private.asc"
}
make_key "$work/keys" "right passphrase"
make_key "$work/other" "other passphrase"

# A release folder: the checksums, two packages, and a dmg that is covered by the checksums only.
make_folder() {
    local folder="$1"
    mkdir -p "$folder"
    echo "appimage" > "$folder/MoltenTerm-linux-x86_64-1.0.0.AppImage"
    echo "deb" > "$folder/moltenterm-linux-amd64-1.0.0.deb"
    echo "dmg" > "$folder/MoltenTerm-darwin-arm64-1.0.0.dmg"
    (cd "$folder" && sha256sum -- *.dmg *.AppImage *.deb > SHA256SUMS.txt)
}

# run <case> <public key or ""> <private key file or ""> <passphrase>: the script's exit status, its log in
# $work/<case>.log and its outputs in $work/<case>.out.
run() {
    local name="$1" public="$2" private="$3" passphrase="$4"
    make_folder "$work/$name"
    : > "$work/$name.out"
    local status=0
    env -u GNUPGHOME \
        MOLTENTERM_RELEASE_PUBLIC_KEY="${public:-$work/no-such-key.asc}" \
        RELEASE_GPG_PRIVATE_KEY="$([ -n "$private" ] && cat "$private" || true)" \
        RELEASE_GPG_PASSPHRASE="$passphrase" \
        GITHUB_OUTPUT="$work/$name.out" \
        bash "$sign" "$work/$name" > "$work/$name.log" 2>&1 || status=$?
    return "$status"
}

if run none "" "" "" && grep -qxF "signed=false" "$work/none.out" && grep -q "::notice::" "$work/none.log" &&
    ! ls "$work/none"/*.asc > /dev/null 2>&1; then
    pass "no key and no secret: unsigned, and the log says so"
else
    fail "no key and no secret"
    cat "$work/none.log"
fi

fingerprint="$(GNUPGHOME="$work/keys" gpg --batch --with-colons --fingerprint 2> /dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
if run signed "$work/keys/public.asc" "$work/keys/private.asc" "right passphrase" &&
    grep -qxF "signed=true" "$work/signed.out" && grep -qxF "fingerprint=$fingerprint" "$work/signed.out"; then
    # What a user does: import the published key into their own keyring, verify, then check the files.
    mkdir -m 700 "$work/user"
    GNUPGHOME="$work/user" gpg --batch --quiet --import "$work/keys/public.asc" 2> /dev/null
    if GNUPGHOME="$work/user" gpg --batch --verify "$work/signed/SHA256SUMS.txt.asc" "$work/signed/SHA256SUMS.txt" 2> /dev/null &&
        GNUPGHOME="$work/user" gpg --batch --verify "$work/signed/moltenterm-linux-amd64-1.0.0.deb.asc" "$work/signed/moltenterm-linux-amd64-1.0.0.deb" 2> /dev/null &&
        GNUPGHOME="$work/user" gpg --batch --verify "$work/signed/MoltenTerm-linux-x86_64-1.0.0.AppImage.asc" "$work/signed/MoltenTerm-linux-x86_64-1.0.0.AppImage" 2> /dev/null &&
        (cd "$work/signed" && sha256sum --ignore-missing -c SHA256SUMS.txt > /dev/null); then
        pass "the right key and passphrase: gpg --verify accepts SHA256SUMS.txt.asc and the package signatures"
    else
        fail "gpg --verify of the signed folder"
    fi
    echo "tampered" >> "$work/signed/SHA256SUMS.txt"
    if GNUPGHOME="$work/user" gpg --batch --verify "$work/signed/SHA256SUMS.txt.asc" "$work/signed/SHA256SUMS.txt" 2> /dev/null; then
        fail "gpg --verify accepted a changed SHA256SUMS.txt"
    else
        pass "a changed SHA256SUMS.txt no longer verifies"
    fi
else
    fail "the right key and passphrase"
    cat "$work/signed.log"
fi

expect_failure() {
    local name="$1" label="$2" pattern="$3"
    shift 3
    if run "$name" "$@"; then
        fail "$label: the run succeeded"
        cat "$work/$name.log"
    elif ! grep -q "::error::.*$pattern" "$work/$name.log" || ls "$work/$name"/*.asc > /dev/null 2>&1 ||
        grep -qxF "signed=true" "$work/$name.out"; then
        fail "$label: no matching error, or a signature was left"
        cat "$work/$name.log"
    else
        pass "$label: the run fails"
    fi
}
expect_failure wrong-passphrase "a wrong passphrase" "Could not sign" \
    "$work/keys/public.asc" "$work/keys/private.asc" "wrong passphrase"
expect_failure no-passphrase "no passphrase" "RELEASE_GPG_PASSPHRASE" \
    "$work/keys/public.asc" "$work/keys/private.asc" ""
expect_failure no-public-key "a secret without a committed key" "no public key is committed" \
    "" "$work/keys/private.asc" "right passphrase"
expect_failure no-secret "a committed key without the secret" "secret is missing" \
    "$work/keys/public.asc" "" ""
expect_failure other-key "a secret that is not the committed key" "is not the committed release key" \
    "$work/keys/public.asc" "$work/other/private.asc" "other passphrase"

if [ "$failures" -ne 0 ]; then
    echo "$failures case(s) failed"
    exit 1
fi
echo "every case passed"
