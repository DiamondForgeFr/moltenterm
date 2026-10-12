// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"slices"
	"sort"
)

// The settings that turn the integration off (FR-SHELL-040, DS-SHELL-052). They are read at each launch, so a change
// applies from the next one without restarting MoltenTerm.
const (
	SettingIntegrate    = "agent:integrate"
	SettingIntegrateOff = "agent:integrateoff"
)

// Why a launch adds nothing because of the settings, or because they could not be read.
const (
	StepAsideSettingsOff      = "the integration is turned off in MoltenTerm's settings (" + SettingIntegrate + ")"
	StepAsideSettingsAgentOff = "the integration is turned off for this agent in MoltenTerm's settings (" + SettingIntegrateOff + ")"
	StepAsideSettingsUnknown  = "MoltenTerm's settings could not be read in time"
)

// IntegrationSettings are the two settings as wavesrv holds them: Integrate nil is the default, on.
type IntegrationSettings struct {
	Integrate *bool
	Off       []string
}

// StepAside tells why the settings keep an agent's launch from being integrated, or "".
func (s IntegrationSettings) StepAside(agentId string) string {
	if s.Integrate != nil && !*s.Integrate {
		return StepAsideSettingsOff
	}
	if slices.Contains(s.Off, agentId) {
		return StepAsideSettingsAgentOff
	}
	return ""
}

// UnknownOff lists the ids of agent:integrateoff that no launch adapter has: they are ignored, and the status says so.
func (s IntegrationSettings) UnknownOff() []string {
	var rtn []string
	for _, id := range s.Off {
		if FindAdapter(id) == nil && !slices.Contains(rtn, id) {
			rtn = append(rtn, id)
		}
	}
	sort.Strings(rtn)
	return rtn
}
