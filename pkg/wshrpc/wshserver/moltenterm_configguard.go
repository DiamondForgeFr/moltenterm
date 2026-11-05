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
// Only the MoltenTerm window and Electron main, where the user answers, write them.
var moltenConsentConfigKeys = map[string]bool{
	wconfig.ConfigKey_BrowserAgentSites:      true,
	wconfig.ConfigKey_BrowserSitePermissions: true,
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
