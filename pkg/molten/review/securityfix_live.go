// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/machineload"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
	"github.com/wavetermdev/waveterm/pkg/molten/sfticket"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const consentReadTimeout = 5 * time.Second

// agentStopper ends the session of a terminal's agent. The sessions package registers it at its start: it imports this
// package, so this one cannot import it.
var agentStopper atomic.Pointer[func(ctx context.Context, blockId string) (bool, error)]

// UseAgentStopper registers how a terminal's agent session is ended (sessions.EndBlockSession).
func UseAgentStopper(stop func(ctx context.Context, blockId string) (bool, error)) {
	agentStopper.Store(&stop)
}

func liveStopAgent(ctx context.Context, blockId string) (bool, error) {
	if stop := agentStopper.Load(); stop != nil {
		return (*stop)(ctx, blockId)
	}
	return false, nil
}

// liveSecurityConsent reads what the developer answered about starting a fix without a click: the setting and, with it,
// the confirmation the window wrote in the client's meta.
func liveSecurityConsent() string {
	setting := wconfig.GetWatcher().GetFullConfig().Settings.ReviewSecurityFix
	if setting == nil || !*setting {
		return secfix.ConsentOf(setting, nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), consentReadTimeout)
	defer cancel()
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil || client == nil {
		return secfix.ConsentOff
	}
	return secfix.ConsentOf(setting, client.Meta)
}

// liveAgentsWorking counts the agents at work now, whoever started them.
func liveAgentsWorking() int {
	count := 0
	for _, run := range attention.AgentRuns() {
		if run.Running && run.State == molten.AgentStateWorking {
			count++
		}
	}
	return count
}

func liveSecurityFixEnv() SecurityFixEnv {
	return SecurityFixEnv{
		Store:            mission.LiveSecurityFixes,
		Result:           mission.LiveSecurityResult,
		Consent:          liveSecurityConsent,
		Run:              sfticket.Runner(mission.ExecRunner),
		ProjectWorkspace: attention.ProjectWorkspace,
		AgentsWorking:    liveAgentsWorking,
		MachineLoaded:    func() bool { return machineload.Default.Read().Loaded },
		StopAgent:        liveStopAgent,
		Declaration:      mission.SecurityDeclaration,
	}
}
