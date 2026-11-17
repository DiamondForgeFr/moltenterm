// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshserver

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// moltenConsentConfigKeys are the settings that record what the user allowed a site or an agent to do in the browser
// panel (#1961, FR-BRW-009, FR-BRW-014). Wave's setconfig writes any key for any caller, so an agent told by a page to
// run `wsh setconfig 'browser:agentsites={"bank.example":"allow"}'` would give itself a site the user never approved.
// browser:clientcertificates is the same kind of answer (#1979, FR-BRW-016): the certificate that identifies the user to
// a site, which an agent must never choose. Only the MoltenTerm window and Electron main, where the user answers, write
// them. browser:localpages lists the files the user let a terminal open in the panel without a question (#1978).
// boss:autoapprove lets Brokk's agent act without asking (#2257): an agent must never give it to itself.
var moltenConsentConfigKeys = map[string]bool{
	wconfig.ConfigKey_BrowserAgentSites:         true,
	wconfig.ConfigKey_BrowserSitePermissions:    true,
	wconfig.ConfigKey_BrowserClientCertificates: true,
	wconfig.ConfigKey_BrowserLocalPages:         true,
	wconfig.ConfigKey_BossAutoApprove:           true,
}

func moltenCheckConfigWrite(ctx context.Context, meta waveobj.MetaMapType) error {
	var refused []string
	for key := range meta {
		if moltenConsentConfigKeys[key] {
			refused = append(refused, key)
		}
	}
	if len(refused) == 0 {
		return nil
	}
	if moltenMetaCaller(ctx, false).Trusted {
		return nil
	}
	sort.Strings(refused)
	return fmt.Errorf("refused: a terminal cannot set %s; the user answers in the MoltenTerm window", strings.Join(refused, ", "))
}
