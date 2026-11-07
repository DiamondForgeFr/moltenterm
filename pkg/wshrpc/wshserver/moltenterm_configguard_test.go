// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The site decisions of the browser panel are the user's answers: a terminal (an agent's shell) cannot write them
// through setconfig, a window and Electron main can, and other keys stay open to terminals (#1961).
func TestMoltenConsentConfigCallers(t *testing.T) {
	e := routetest.Make(t)
	saved := wshutil.DefaultRouter
	wshutil.DefaultRouter = e.Router
	t.Cleanup(func() { wshutil.DefaultRouter = saved })
	ctxOf := func(from routetest.From) context.Context {
		return wshutil.WithCallerContext(context.Background(), from.Source, from.Link)
	}
	consent := []waveobj.MetaMapType{
		{wconfig.ConfigKey_BrowserAgentSites: map[string]any{"bank.example": "allow"}},
		{wconfig.ConfigKey_BrowserSitePermissions: map[string]any{"bank.example": map[string]any{"camera": "allow"}}},
		{wconfig.ConfigKey_BrowserClientCertificates: map[string]any{"bank.example": "sha256/abc"}},
		{"term:fontsize": 12, wconfig.ConfigKey_BrowserAgentSites: nil},
	}
	for _, from := range []routetest.From{e.Window(), e.Electron()} {
		for _, meta := range consent {
			if err := moltenCheckConfigWrite(ctxOf(from), meta); err != nil {
				t.Errorf("%s refused %v: %v", from.Name, meta, err)
			}
		}
	}
	if err := moltenCheckConfigWrite(context.Background(), consent[0]); err != nil {
		t.Errorf("wavesrv refused: %v", err)
	}
	untrusted := append([]routetest.From{e.Terminal()}, e.Forged()...)
	for _, from := range untrusted {
		for _, meta := range consent {
			mustRefuseConsentConfig(t, from.Name, moltenCheckConfigWrite(ctxOf(from), meta))
		}
		if err := moltenCheckConfigWrite(ctxOf(from), waveobj.MetaMapType{"term:fontsize": 12}); err != nil {
			t.Errorf("%s refused a key outside the consent keys: %v", from.Name, err)
		}
	}
	// The command itself refuses before writing anything.
	err := WshServerImpl.SetConfigCommand(ctxOf(e.Terminal()), wshrpc.MetaSettingsType{MetaMapType: consent[0]})
	mustRefuseConsentConfig(t, "setconfig from a terminal", err)
}

func mustRefuseConsentConfig(t *testing.T, name string, err error) {
	t.Helper()
	if err == nil || !strings.HasPrefix(err.Error(), "refused: a terminal cannot set browser:") {
		t.Errorf("%s: %v, want a refusal", name, err)
	}
}
