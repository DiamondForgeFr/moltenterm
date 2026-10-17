// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package authkey

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
)

const CallerHeader = "X-Molten-Caller"
const CallerProofHeader = "X-Molten-Proof"
const CallerSecretEnv = "WAVETERM_CALLER_SECRET"
const AppOriginEnv = "WAVETERM_APP_ORIGIN"

// CallerPolicy supplements the legacy auth key with authority that is never returned to renderer IPC.
// The renderer proof is injected only for registered app main frames by Electron main's session hook.
type CallerPolicy struct {
	proofs    map[string][]byte
	devOrigin string
}

func NewCallerPolicy(secret, devOrigin string) (*CallerPolicy, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("missing or short application caller secret")
	}
	if devOrigin != "" {
		u, err := url.Parse(devOrigin)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil ||
			u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("invalid application development origin")
		}
	}
	p := &CallerPolicy{devOrigin: devOrigin, proofs: make(map[string][]byte)}
	for _, caller := range []string{"renderer", "main"} {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte("moltenterm-app-caller:v1:" + caller))
		p.proofs[caller] = mac.Sum(nil)
	}
	return p, nil
}

func (p *CallerPolicy) Validate(r *http.Request) error {
	if p == nil || len(r.Header.Values(CallerHeader)) != 1 || len(r.Header.Values(CallerProofHeader)) != 1 {
		return fmt.Errorf("application caller proof required")
	}
	caller := r.Header.Get(CallerHeader)
	expected, exists := p.proofs[caller]
	proof, err := hex.DecodeString(r.Header.Get(CallerProofHeader))
	if !exists || err != nil || !hmac.Equal(proof, expected) {
		return fmt.Errorf("invalid application caller proof")
	}
	origins := r.Header.Values("Origin")
	if len(origins) > 1 {
		return fmt.Errorf("multiple application origins")
	}
	origin := r.Header.Get("Origin")
	if caller == "main" {
		if len(origins) != 0 {
			return fmt.Errorf("native application caller must not supply a browser origin")
		}
		return nil
	}
	if p.devOrigin != "" {
		// Same-origin GET/media requests omit Origin. They still need the private injected renderer proof.
		if len(origins) == 0 || origin == p.devOrigin {
			return nil
		}
	} else if len(origins) == 0 || origin == "null" || origin == "file://" {
		// Chromium file documents use file:// for WS, null for CORS, and no Origin for same-site resources.
		// Opaque/local origins alone confer no authority: only a verified renderer proof permits them.
		return nil
	}
	return fmt.Errorf("application origin is not allowed")
}

func (p *CallerPolicy) AllowsPreflight(origin string) bool {
	return p != nil && p.devOrigin != "" && origin == p.devOrigin
}
