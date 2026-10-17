// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const previewResourcePrefix = "/wave/preview-resource/"
const previewResourceTTL = 10 * time.Minute
const previewResourceLimit = 512

type previewResource struct {
	path    string
	expires time.Time
}

// Tokens authorize only reading one PDF. They are not caller proofs and never identify an application window.
// Only the authenticated app renews/revokes them; an iframe cannot keep a leaked token alive by reading it.
type previewCapabilities struct {
	mu        sync.Mutex
	resources map[string]previewResource
	now       func() time.Time
	limit     int
	stat      func(context.Context, string) (*wshrpc.FileInfo, error)
	stream    func(http.ResponseWriter, *http.Request, string) error
	authorize func(*http.Request) error
}

func newPreviewCapabilities(stat func(context.Context, string) (*wshrpc.FileInfo, error), stream func(http.ResponseWriter, *http.Request, string) error, authorize func(*http.Request) error) *previewCapabilities {
	return &previewCapabilities{
		resources: make(map[string]previewResource), now: time.Now, limit: previewResourceLimit,
		stat: stat, stream: stream, authorize: authorize,
	}
}

func previewHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func (p *previewCapabilities) issue(w http.ResponseWriter, r *http.Request) {
	previewHeaders(w)
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if err := p.authorize(r); err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var request struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&request); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	conn, err := connparse.ParseURI(request.Path)
	if err != nil || !strings.HasPrefix(request.Path, "wsh://") || conn.Scheme != "wsh" || conn.Host == "current" || conn.Path == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	info, err := p.stat(r.Context(), conn.GetFullURI())
	if err != nil || info == nil || info.NotFound || info.IsDir || info.StatError != "" || info.MimeType != "application/pdf" || info.Path == "" {
		w.WriteHeader(http.StatusUnsupportedMediaType)
		return
	}
	// Freeze the resolved connection and cleaned file path; later requests cannot supply another path/host.
	conn.Path = info.Path
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	token := hex.EncodeToString(random[:])
	p.mu.Lock()
	now := p.now()
	for token, resource := range p.resources {
		if !resource.expires.After(now) {
			delete(p.resources, token)
		}
	}
	if len(p.resources) >= p.limit {
		p.mu.Unlock()
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	expires := now.Add(previewResourceTTL)
	p.resources[token] = previewResource{path: conn.GetFullURI(), expires: expires}
	p.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"token": token, "expiresat": expires.UnixMilli()})
}

func previewToken(r *http.Request) string {
	if r.URL.RawQuery != "" || !strings.HasPrefix(r.URL.Path, previewResourcePrefix) {
		return ""
	}
	token := strings.TrimPrefix(r.URL.Path, previewResourcePrefix)
	decoded, err := hex.DecodeString(token)
	if err != nil || len(decoded) != 32 || len(token) != 64 {
		return ""
	}
	return token
}

func (p *previewCapabilities) resource(w http.ResponseWriter, r *http.Request) {
	previewHeaders(w)
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	mutating := r.Method == http.MethodPost || r.Method == http.MethodDelete
	if mutating {
		if err := p.authorize(r); err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
	}
	token := previewToken(r)
	p.mu.Lock()
	resource, exists := p.resources[token]
	if exists && !resource.expires.After(p.now()) {
		delete(p.resources, token)
		exists = false
	}
	if exists && r.Method == http.MethodPost {
		resource.expires = p.now().Add(previewResourceTTL)
		p.resources[token] = resource
	} else if exists && r.Method == http.MethodDelete {
		delete(p.resources, token)
	}
	p.mu.Unlock()
	if !exists {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if mutating {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// The streaming function enforces PDF MIME before sending headers/body, including after file changes.
	if err := p.stream(w, r, resource.path); err != nil {
		// Do not log the capability URL or disclose the bound path to the iframe.
		http.Error(w, "PDF preview unavailable", http.StatusBadGateway)
	}
}
