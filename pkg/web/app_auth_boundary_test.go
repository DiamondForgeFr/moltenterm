// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/wavetermdev/waveterm/pkg/authkey"
)

const boundaryKey = "test-application-key"
const boundarySecret = "separate private test proof secret of at least thirty two bytes"

func configureBoundary(t *testing.T, devOrigin string) {
	t.Helper()
	t.Setenv(authkey.WaveAuthKeyEnv, boundaryKey)
	t.Setenv(authkey.CallerSecretEnv, boundarySecret)
	t.Setenv(authkey.AppOriginEnv, devOrigin)
	if err := authkey.SetAuthKeyFromEnv(); err != nil {
		t.Fatal(err)
	}
}

func boundaryHeaders(caller, origin string, proof bool) http.Header {
	h := make(http.Header)
	h.Set(authkey.AuthKeyHeader, boundaryKey)
	if caller != "" {
		h.Set(authkey.CallerHeader, caller)
	}
	if proof {
		mac := hmac.New(sha256.New, []byte(boundarySecret))
		mac.Write([]byte("moltenterm-app-caller:v1:" + caller))
		h.Set(authkey.CallerProofHeader, hex.EncodeToString(mac.Sum(nil)))
	}
	if origin != "<missing>" {
		h.Set("Origin", origin)
	}
	return h
}

func TestAppHTTPBoundaryUsesCallerProofAndOrigin(t *testing.T) {
	configureBoundary(t, "")
	called := false
	info := WebFnWrap(WebFnOpts{}, func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.Write([]byte(`{"application":true}`))
	})
	for _, tc := range []struct {
		name, caller, origin string
		proof, allowed       bool
	}{
		{"legacy-key-only", "", "<missing>", false, false},
		{"guest", "renderer", "https://example.test", false, false},
		{"popup", "renderer", "http://127.0.0.1", false, false},
		{"opaque-subframe", "renderer", "null", false, false},
		{"wrong-browser-origin-with-proof", "renderer", "https://example.test", true, false},
		{"native-spoofed-origin", "main", "null", true, false},
		{"native-main", "main", "<missing>", true, true},
		{"packaged-fetch", "renderer", "null", true, true},
		{"packaged-media", "renderer", "<missing>", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called = false
			r := httptest.NewRequest("GET", "/info", nil)
			r.Header = boundaryHeaders(tc.caller, tc.origin, tc.proof)
			w := httptest.NewRecorder()
			info(w, r)
			if called != tc.allowed || (w.Code == http.StatusOK) != tc.allowed {
				t.Fatalf("called=%t status=%d, want allowed=%t", called, w.Code, tc.allowed)
			}
		})
	}
}

func TestAppWebSocketBoundaryUsesTheSamePolicy(t *testing.T) {
	configureBoundary(t, "")
	// Harmless metadata operation through the real authenticated wrapper and production upgrader policy.
	server := httptest.NewServer(http.HandlerFunc(WebFnWrap(WebFnOpts{}, func(w http.ResponseWriter, r *http.Request) {
		conn, err := WebSocketUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(map[string]bool{"application": true})
	})))
	defer server.Close()
	for _, tc := range []struct {
		caller, origin string
		proof, allowed bool
	}{
		{"", "<missing>", false, false},
		{"renderer", "null", false, false},
		{"renderer", "https://example.test", true, false},
		{"main", "<missing>", true, true},
		{"renderer", "file://", true, true},
	} {
		conn, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), boundaryHeaders(tc.caller, tc.origin, tc.proof))
		if (err == nil) != tc.allowed {
			t.Fatalf("caller=%s origin=%s: %v", tc.caller, tc.origin, err)
		}
		if conn != nil {
			var info map[string]bool
			if err := conn.ReadJSON(&info); err != nil || !info["application"] {
				t.Fatalf("metadata: %+v %v", info, err)
			}
			conn.Close()
		} else if response == nil || response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauthenticated websocket status: %+v", response)
		}
	}
}

func TestAppDevelopmentCORSDoesNotReflectOtherOrigins(t *testing.T) {
	configureBoundary(t, "http://localhost:5173")
	handler := makeWebHandler()
	for _, origin := range []string{"http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173", "https://example.test", "null", ""} {
		r := httptest.NewRequest("OPTIONS", "/wave/service", nil)
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		allowed := origin == "http://localhost:5173"
		if (w.Code == http.StatusNoContent) != allowed || (w.Header().Get("Access-Control-Allow-Origin") == origin && origin != "") != allowed {
			t.Fatalf("origin %q status %d headers %+v", origin, w.Code, w.Header())
		}
	}
	// A preview capability string cannot be used as a backend caller proof or privileged route credential.
	r := httptest.NewRequest("GET", "/wave/service", nil)
	r.Header.Set(authkey.AuthKeyHeader, strings.Repeat("a", 64))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("resource token reached service: %d", w.Code)
	}
}

func TestPackagedCORSRequiresProvenRendererEvenForPreflight(t *testing.T) {
	configureBoundary(t, "")
	handler := makeWebHandler()
	for _, method := range []string{"OPTIONS", "GET"} {
		for _, tc := range []struct {
			caller, origin string
			proof, allowed bool
		}{
			{"renderer", "null", true, true},
			{"renderer", "file://", true, true},
			{"renderer", "null", false, false},
			{"", "null", false, false},
			{"main", "null", true, false},
			{"renderer", "https://example.test", true, false},
		} {
			r := httptest.NewRequest(method, "/schema/", nil)
			r.Header = boundaryHeaders(tc.caller, tc.origin, tc.proof)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if (w.Header().Get("Access-Control-Allow-Origin") == tc.origin) != tc.allowed {
				t.Fatalf("%s caller=%s origin=%s proof=%t: headers %+v", method, tc.caller, tc.origin, tc.proof, w.Header())
			}
			if method == "OPTIONS" && (w.Code == http.StatusNoContent) != tc.allowed {
				t.Fatalf("preflight status=%d, allowed=%t", w.Code, tc.allowed)
			}
		}
	}
}
