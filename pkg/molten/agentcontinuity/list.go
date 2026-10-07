// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"context"
)

// The read-only listing of every known agent (FR-CONT-006 AC1, DS-CONT-007): molten agent list prints it, and the
// agent list of Continue with… (#331) offers the agents that are Supported and Installed.

// QuotaSource is one way MoltenTerm knows an agent's plan usage, from its usage adapter's gauges sources.
type QuotaSource struct {
	Id      string `json:"id"`
	Name    string `json:"name"`
	Support string `json:"support"`
}

// QuotaInfo is the agent's usage page and its gauges sources, best first.
type QuotaInfo struct {
	PageURL  string        `json:"pageurl,omitempty"`
	PageName string        `json:"pagename,omitempty"`
	Sources  []QuotaSource `json:"sources,omitempty"`
}

// AgentListing is one known agent. Supported: it has an adapter; Unsupported says why not.
type AgentListing struct {
	Id          string `json:"id"`
	Name        string `json:"name"`
	Executable  string `json:"executable"`
	Supported   bool   `json:"supported"`
	Unsupported string `json:"unsupported,omitempty"`
	Detection
	Models       []ModelChoice         `json:"models,omitempty"`
	Briefing     *BriefingChannel      `json:"briefing,omitempty"`
	Capabilities map[string]Capability `json:"capabilities,omitempty"`
	Exit         *ExitSequence         `json:"exit,omitempty"`
	// Launcher: MoltenTerm's launcher integrates the agent's runs (#318, #320).
	Launcher        bool       `json:"launcher"`
	TranscriptRoots []string   `json:"transcriptroots,omitempty"`
	Quota           *QuotaInfo `json:"quota,omitempty"`
	GuideProfile    string     `json:"guideprofile,omitempty"`
}

// Offered tells whether Continue with… may offer the agent.
func (l AgentListing) Offered() bool {
	return l.Supported && l.Installed
}

// List describes every known agent: the adapters in registration order, then the planned agents. Detection runs in
// parallel and is bounded by the probe timeout.
func (r *Registry) List(ctx context.Context, detector *Detector, denv DetectEnv, menv ModelEnv) []AgentListing {
	adapters := r.Adapters()
	var exes []string
	for _, a := range adapters {
		exes = append(exes, a.Executable())
	}
	for _, p := range PlannedAgents {
		exes = append(exes, p.Executable)
	}
	detected := detector.DetectAll(ctx, exes, denv)
	var rtn []AgentListing
	for _, a := range adapters {
		rtn = append(rtn, describeAdapter(a, detected[a.Executable()], menv))
	}
	for _, p := range PlannedAgents {
		rtn = append(rtn, AgentListing{Id: p.Id, Name: p.Name, Executable: p.Executable, Unsupported: p.Reason, Detection: detected[p.Executable]})
	}
	return rtn
}

func describeAdapter(a AgentAdapter, detection Detection, menv ModelEnv) AgentListing {
	briefing := a.Briefing()
	exit := a.Exit()
	listing := AgentListing{
		Id:           a.Id(),
		Name:         a.Name(),
		Executable:   a.Executable(),
		Supported:    true,
		Detection:    detection,
		Models:       a.Models(menv),
		Briefing:     &briefing,
		Capabilities: a.Capabilities(),
		Exit:         &exit,
		Launcher:     a.Launch() != nil,
		GuideProfile: a.GuideProfile(),
	}
	if t := a.Transcripts(); t != nil {
		listing.TranscriptRoots = t.Roots()
	}
	if u := a.Usage(); u != nil {
		quota := &QuotaInfo{PageURL: u.PageURL(), PageName: u.PageName()}
		for _, s := range u.Sources() {
			support := SupportUndocumented
			if s.Documented() {
				support = SupportDocumented
			}
			quota.Sources = append(quota.Sources, QuotaSource{Id: s.Id(), Name: s.Name(), Support: support})
		}
		listing.Quota = quota
	}
	return listing
}
