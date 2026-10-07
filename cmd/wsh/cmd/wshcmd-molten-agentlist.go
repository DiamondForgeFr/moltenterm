// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
)

// The coding agents MoltenTerm knows (FR-CONT-006): `molten agent list` prints each one's detection and capability
// matrix, then where the molten guides are installed. Detection uses the pane's PATH, launchers skipped.

// Above the version probe's 3 s: every agent is probed in parallel.
const moltenAgentListTimeout = 5 * time.Second

// MoltenAgentList is `molten agent list --json`.
type MoltenAgentList struct {
	Agents []agentcontinuity.AgentListing `json:"agents"`
	Guides []molten.AgentStatus           `json:"guides"`
}

func moltenAgentListings(env molten.AgentEnv) []agentcontinuity.AgentListing {
	ctx, cancel := context.WithTimeout(context.Background(), moltenAgentListTimeout)
	defer cancel()
	denv := agentcontinuity.DetectEnv{PathList: os.Getenv("PATH"), LauncherDir: os.Getenv(agentlaunch.AgentBinDirVarName)}
	return agentcontinuity.Default().List(ctx, agentcontinuity.DefaultDetector, denv, env)
}

func moltenSupportMark(support string) string {
	switch support {
	case agentcontinuity.SupportDocumented:
		return "D"
	case agentcontinuity.SupportUndocumented:
		return "U"
	}
	return "-"
}

func moltenCapabilityMark(l agentcontinuity.AgentListing, capability string) string {
	c, ok := l.Capabilities[capability]
	if !ok {
		return "-"
	}
	mark := moltenSupportMark(c.Support)
	if c.InUse {
		mark += "*"
	}
	return mark
}

func moltenInstalledCell(l agentcontinuity.AgentListing) string {
	if l.Installed {
		return "yes"
	}
	return "no"
}

func formatMoltenAgentListings(listings []agentcontinuity.AgentListing) string {
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)
	fmt.Fprintf(tw, "AGENT\tINSTALLED\tVERSION\tBRIEFING\tMODELS\tRESUME\tTRANSCRIPT\tQUOTA\tMCP\tPATH\n")
	for _, l := range listings {
		version := agentcontinuity.StripControl(l.Version)
		if version == "" {
			version = "-"
		}
		briefing := "-"
		if l.Briefing != nil {
			briefing = l.Briefing.Channel + " " + moltenSupportMark(l.Briefing.Support)
		}
		models := "-"
		if l.Supported {
			models = fmt.Sprintf("%d", moltenNamedModels(l.Models))
		}
		path := agentcontinuity.StripControl(l.Path)
		if path == "" {
			path = "-"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", l.Id, moltenInstalledCell(l), version, briefing, models,
			moltenCapabilityMark(l, agentcontinuity.CapResume), moltenCapabilityMark(l, agentcontinuity.CapTranscript),
			moltenCapabilityMark(l, agentcontinuity.CapQuota), moltenCapabilityMark(l, agentcontinuity.CapMcp), path)
	}
	tw.Flush()
	for _, l := range listings {
		var why []string
		if l.Reason != "" {
			why = append(why, l.Reason)
		}
		if l.Unsupported != "" {
			why = append(why, l.Unsupported)
		}
		if len(why) > 0 {
			fmt.Fprintf(&sb, "%s: %s\n", l.Name, agentcontinuity.StripControl(strings.Join(why, "; ")))
		}
	}
	sb.WriteString("D documented, U undocumented, - unavailable, * used by MoltenTerm today; MODELS besides your default; details with --json\n")
	return sb.String()
}

// moltenNamedModels counts the models offered besides the agent's default.
func moltenNamedModels(models []agentcontinuity.ModelChoice) int {
	count := 0
	for _, m := range models {
		if m.Id != "" {
			count++
		}
	}
	return count
}
