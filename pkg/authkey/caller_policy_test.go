// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package authkey

import (
	"encoding/hex"
	"net/http/httptest"
	"testing"
)

func TestCallerPolicy(t *testing.T) {
	for _, devOrigin := range []string{"", "http://localhost:5173"} {
		p, err := NewCallerPolicy("a separate random proof secret, not the renderer auth key", devOrigin)
		if err != nil {
			t.Fatal(err)
		}
		for _, caller := range []string{"renderer", "main"} {
			for _, origin := range []string{"<missing>", "", "null", "file://", "http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173", "https://example.test"} {
				t.Run(devOrigin+"/"+caller+"/"+origin, func(t *testing.T) {
					r := httptest.NewRequest("GET", "http://127.0.0.1/info", nil)
					r.Header.Set(CallerHeader, caller)
					r.Header.Set(CallerProofHeader, hex.EncodeToString(p.proofs[caller]))
					if origin != "<missing>" {
						r.Header.Set("Origin", origin)
					}
					want := origin == "<missing>"
					if caller == "renderer" {
						want = want || (devOrigin != "" && origin == devOrigin) || (devOrigin == "" && (origin == "null" || origin == "file://"))
					}
					if got := p.Validate(r) == nil; got != want {
						t.Fatalf("allowed=%t, want %t", got, want)
					}
					r.Header.Del(CallerProofHeader)
					if p.Validate(r) == nil {
						t.Fatal("origin without proof was trusted")
					}
				})
			}
		}
	}
}

func TestCallerProofCannotBeReusedAsAnotherClass(t *testing.T) {
	p, _ := NewCallerPolicy("a separate random proof secret, not the renderer auth key", "")
	// Shared Node/Go vector guards the process boundary's encoding and domain separator.
	if got := hex.EncodeToString(p.proofs["renderer"]); got != "7af68741fcf61f4332f27be8bfa71b6c9edd8d043be94ea8721db625518d8d62" {
		t.Fatalf("cross-process proof mismatch: %s", got)
	}
	r := httptest.NewRequest("GET", "http://127.0.0.1/info", nil)
	r.Header.Set(CallerHeader, "main")
	r.Header.Set(CallerProofHeader, hex.EncodeToString(p.proofs["renderer"]))
	if p.Validate(r) == nil {
		t.Fatal("renderer proof granted native caller authority")
	}
	other, _ := NewCallerPolicy("a different startup secret of at least thirty two bytes", "")
	r.Header.Set(CallerProofHeader, hex.EncodeToString(other.proofs["main"]))
	if p.Validate(r) == nil {
		t.Fatal("proof survived a different application startup")
	}
	r.Header.Set(CallerProofHeader, hex.EncodeToString(p.proofs["main"]))
	r.Header.Add(CallerHeader, "renderer")
	if p.Validate(r) == nil {
		t.Fatal("ambiguous caller headers accepted")
	}
}

func TestCallerPolicyPreflightAndConfiguration(t *testing.T) {
	secret := "a separate random proof secret, not the renderer auth key"
	for _, origin := range []string{"null", "file://", "http://localhost:5173/index.html", "http://user@localhost:5173", "http://localhost:5173?x=1"} {
		if _, err := NewCallerPolicy(secret, origin); err == nil {
			t.Errorf("accepted invalid configured origin %q", origin)
		}
	}
	if _, err := NewCallerPolicy("", ""); err == nil {
		t.Fatal("accepted missing secret")
	}
	p, _ := NewCallerPolicy(secret, "http://localhost:5173")
	for _, origin := range []string{"", "null", "http://127.0.0.1:5173", "http://localhost:5173.evil.test", "http://localhost:5173"} {
		if got := p.AllowsPreflight(origin); got != (origin == "http://localhost:5173") {
			t.Errorf("preflight %q allowed=%t", origin, got)
		}
	}
}
