#!/usr/bin/env bash
# Copyright 2026, DiamondForge
# SPDX-License-Identifier: Apache-2.0
#
# The code-signing identity local builds (the gold and any other local build) sign with (#224), modelled on Notulia's
# scripts/local-signing-identity.sh.
#
# Signed ad hoc, a build is known to macOS by the hash of its code, which changes with every build: the Files and
# Folders and Full Disk Access grants given to the previous gold stop applying to the next one, while System Settings
# still shows them as allowed. Signed with one certificate, the app is known by "identifier + certificate leaf", and the
# grants carry over from one build to the next.
#
# Nothing in it is specific to Moltenterm but the default name: any standalone app can use it with --name.
#
# usage: scripts/moltenterm-local-signing-identity.sh [--check] [--name <identity>]
#
#   (no flag)  Run once by the developer, from a terminal. Ensures a VALID identity of that name exists in the login
#              keychain, creating it the first time: a self-signed code-signing certificate whose private key never
#              leaves the keychain. macOS asks once to trust it for code signing (codesign refuses an identity the
#              system does not trust), then once to let codesign use its key ("Always Allow"), so no build waits on a
#              dialog later.
#   --check    Read-only, what the build runs: exits 0 when the identity is valid, 1 when it is not.
#
# The name defaults to $MOLTENTERM_SIGNING_IDENTITY, then "MoltenTerm Local".
set -euo pipefail

NAME="${MOLTENTERM_SIGNING_IDENTITY:-MoltenTerm Local}"
CHECK=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --check) CHECK=1 ;;
        --name)
            NAME="${2:?--name needs a value}"
            shift
            ;;
        *)
            echo "usage: moltenterm-local-signing-identity.sh [--check] [--name <identity>]" >&2
            exit 2
            ;;
    esac
    shift
done

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "local code signing is macOS only" >&2
    exit 1
fi

# grep reads everything (no -q): with pipefail, an early exit could SIGPIPE `security` and make a present identity look
# absent.
valid() {
    security find-identity -v -p codesigning 2>/dev/null | grep -F "\"$NAME\"" >/dev/null
}

if valid; then
    [[ $CHECK -eq 1 ]] || echo "✓ The code-signing identity \"$NAME\" is ready."
    exit 0
fi
[[ $CHECK -eq 1 ]] && exit 1

KEYCHAIN="$(security login-keychain | tr -d ' "')"
WORK="$(mktemp -d)"
cleanup() {
    rm -f "$WORK/key.pem" "$WORK/cert.pem" "$WORK/identity.p12" "$WORK/probe"
    rmdir "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

if ! security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
    echo "Creating the code-signing identity \"$NAME\" in $KEYCHAIN…"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -subj "/CN=$NAME" \
        -addext "keyUsage=critical,digitalSignature" \
        -addext "extendedKeyUsage=critical,codeSigning" \
        -addext "basicConstraints=critical,CA:false" 2>/dev/null
    PASS="$(openssl rand -hex 16)"
    # -legacy where available: OpenSSL 3 encrypts PKCS#12 with algorithms `security import` cannot read.
    LEGACY=()
    if openssl pkcs12 -help 2>&1 | grep -q -- "-legacy"; then
        LEGACY=(-legacy)
    fi
    openssl pkcs12 -export ${LEGACY[@]+"${LEGACY[@]}"} -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
        -name "$NAME" -out "$WORK/identity.p12" -passout "pass:$PASS"
    security import "$WORK/identity.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null
else
    # Imported by an earlier run whose trust prompt was refused: trust it now.
    echo "Reusing the certificate \"$NAME\" already in $KEYCHAIN."
    security find-certificate -c "$NAME" -p "$KEYCHAIN" >"$WORK/cert.pem"
fi

echo "macOS will ask to trust \"$NAME\" for code signing: once, for every future local build."
if ! security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"; then
    echo "✗ \"$NAME\" was not trusted: local builds stay signed ad hoc, and macOS forgets their permissions at each build." >&2
    exit 1
fi
if ! valid; then
    echo "✗ \"$NAME\" is still not a valid code-signing identity (security find-identity -v -p codesigning)." >&2
    exit 1
fi

# One throwaway signature, so the keychain asks now, not in the middle of a build, to let codesign use the key.
echo "macOS may now ask to let codesign use the key of \"$NAME\": choose Always Allow."
cp /usr/bin/true "$WORK/probe"
if ! codesign --force --sign "$NAME" "$WORK/probe" 2>/dev/null; then
    echo "✗ codesign could not use \"$NAME\": allow it when the build asks, or run this script again." >&2
    exit 1
fi

echo "✓ The code-signing identity \"$NAME\" is ready."
