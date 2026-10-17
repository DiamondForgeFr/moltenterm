// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func previewFixture() (*previewCapabilities, *time.Time, *[]string) {
	now := time.Unix(100, 0)
	reads := []string{}
	p := newPreviewCapabilities(
		func(context.Context, string) (*wshrpc.FileInfo, error) {
			return &wshrpc.FileInfo{Path: "/fixture.pdf", MimeType: "application/pdf"}, nil
		},
		func(w http.ResponseWriter, r *http.Request, path string) error {
			reads = append(reads, path)
			w.Header().Set("Content-Type", "application/pdf")
			// Generated harmless fixture, served with actual standard HTTP Range and HEAD semantics.
			http.ServeContent(w, r, "fixture.pdf", time.Time{}, strings.NewReader("%PDF-1.7\nfixture\n%%EOF\n"))
			return nil
		},
		func(r *http.Request) error {
			if r.Header.Get("Fixture-App") != "trusted-main-frame" {
				return errors.New("untrusted")
			}
			return nil
		},
	)
	p.now = func() time.Time { return now }
	return p, &now, &reads
}

func issuePreview(t *testing.T, p *previewCapabilities) string {
	t.Helper()
	r := httptest.NewRequest("POST", "/wave/preview-resource", strings.NewReader(`{"path":"wsh://local/fixture.pdf"}`))
	r.Header.Set("Fixture-App", "trusted-main-frame")
	w := httptest.NewRecorder()
	p.issue(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("issue: %d %s", w.Code, w.Body.String())
	}
	var result struct{ Token string }
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Token) != 64 {
		t.Fatalf("bad capability response: %s", w.Body.String())
	}
	return result.Token
}

func TestPreviewCapabilityReadsOnlyItsBoundPDF(t *testing.T) {
	p, _, reads := previewFixture()
	token := issuePreview(t, p)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		r := httptest.NewRequest(method, previewResourcePrefix+token, nil)
		r.Header.Set("Range", "bytes=0-3")
		w := httptest.NewRecorder()
		p.resource(w, r)
		if w.Code != http.StatusPartialContent || w.Header().Get("Content-Type") != "application/pdf" || w.Header().Get("Content-Range") != "bytes 0-3/23" {
			t.Fatalf("range response: %d %+v", w.Code, w.Header())
		}
		if method == http.MethodGet && w.Body.String() != "%PDF" {
			t.Fatalf("range body: %q", w.Body.String())
		}
		if method == http.MethodHead && w.Body.Len() != 0 {
			t.Fatal("HEAD returned a body")
		}
		if w.Header().Get("Referrer-Policy") != "no-referrer" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("capability disclosure/cache protections missing")
		}
	}
	for _, path := range *reads {
		if path != "wsh://local/fixture.pdf" {
			t.Fatalf("resource substituted: %q", path)
		}
	}
	for _, target := range []string{previewResourcePrefix + token + "?path=wsh://local/other.pdf", previewResourcePrefix + token + "/other.pdf", "/wave/service?token=" + token, previewResourcePrefix + strings.Repeat("0", 64)} {
		w := httptest.NewRecorder()
		p.resource(w, httptest.NewRequest("GET", target, nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("accepted substitution %q: %d", target, w.Code)
		}
	}
}

func TestPreviewCapabilityRequiresAppAuthorityToMintRenewAndRevoke(t *testing.T) {
	p, _, _ := previewFixture()
	token := issuePreview(t, p)
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		w := httptest.NewRecorder()
		p.resource(w, httptest.NewRequest(method, previewResourcePrefix+token, nil))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("token alone authorized %s", method)
		}
	}
	w := httptest.NewRecorder()
	p.issue(w, httptest.NewRequest("POST", "/wave/preview-resource", strings.NewReader(`{"path":"wsh://local/fixture.pdf"}`)))
	if w.Code != http.StatusUnauthorized {
		t.Fatal("untrusted mint accepted")
	}
	for _, method := range []string{"PUT", "PATCH", "OPTIONS", "CONNECT"} {
		w := httptest.NewRecorder()
		p.resource(w, httptest.NewRequest(method, previewResourcePrefix+token, nil))
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("unexpected method accepted: %s", method)
		}
	}
}

func TestPreviewCapabilityExpiryRevocationAndCapacity(t *testing.T) {
	p, now, _ := previewFixture()
	p.limit = 1
	token := issuePreview(t, p)
	*now = now.Add(previewResourceTTL - time.Second)
	r := httptest.NewRequest("POST", previewResourcePrefix+token, nil)
	r.Header.Set("Fixture-App", "trusted-main-frame")
	w := httptest.NewRecorder()
	p.resource(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatal("authenticated renewal failed")
	}
	*now = now.Add(2 * time.Second)
	w = httptest.NewRecorder()
	p.resource(w, httptest.NewRequest("HEAD", previewResourcePrefix+token, nil))
	if w.Code != http.StatusOK {
		t.Fatal("renewed capability expired prematurely")
	}
	r = httptest.NewRequest("POST", "/wave/preview-resource", strings.NewReader(`{"path":"wsh://local/fixture.pdf"}`))
	r.Header.Set("Fixture-App", "trusted-main-frame")
	w = httptest.NewRecorder()
	p.issue(w, r)
	if w.Code != http.StatusTooManyRequests || len(p.resources) != 1 {
		t.Fatal("capability storage was not bounded")
	}
	r = httptest.NewRequest("DELETE", previewResourcePrefix+token, nil)
	r.Header.Set("Fixture-App", "trusted-main-frame")
	p.resource(httptest.NewRecorder(), r)
	w = httptest.NewRecorder()
	p.resource(w, httptest.NewRequest("GET", previewResourcePrefix+token, nil))
	if w.Code != http.StatusNotFound {
		t.Fatal("revoked capability still works")
	}
	token = issuePreview(t, p)
	*now = now.Add(previewResourceTTL)
	w = httptest.NewRecorder()
	p.resource(w, httptest.NewRequest("GET", previewResourcePrefix+token, nil))
	if w.Code != http.StatusNotFound {
		t.Fatal("expired capability still works")
	}
	issuePreview(t, p)
}

func TestPreviewCapabilityRejectsNonPDFAndAmbiguousConnections(t *testing.T) {
	p, _, _ := previewFixture()
	for _, path := range []string{"http://example.test/x.pdf", "wsh://current/x.pdf", "/x.pdf", "wsh://local"} {
		body, _ := json.Marshal(map[string]string{"path": path})
		r := httptest.NewRequest("POST", "/wave/preview-resource", strings.NewReader(string(body)))
		r.Header.Set("Fixture-App", "trusted-main-frame")
		w := httptest.NewRecorder()
		p.issue(w, r)
		if w.Code == http.StatusOK {
			t.Errorf("ambiguous resource accepted: %s", path)
		}
	}
	p.stat = func(context.Context, string) (*wshrpc.FileInfo, error) {
		return &wshrpc.FileInfo{Path: "/fixture.html", MimeType: "text/html"}, nil
	}
	r := httptest.NewRequest("POST", "/wave/preview-resource", strings.NewReader(`{"path":"wsh://local/fixture.html"}`))
	r.Header.Set("Fixture-App", "trusted-main-frame")
	w := httptest.NewRecorder()
	p.issue(w, r)
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatal("non-PDF content accepted")
	}
}
