// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// What a running agent's command line tells of its launch (#947): the launcher's report lives in wavesrv's memory and
// is gone once MoltenTerm restarts, while the agent keeps running in its durable shell. Its arguments still carry
// what the launcher added, so the share menu can tell a lost browser connection from a session started without it.

// ArgsIntegration is what a run's arguments show: Integrated, MoltenTerm's launcher added something; Browser, it
// added the molten-browser server.
type ArgsIntegration struct {
	Integrated bool
	Browser    bool
}

// isLaunchFile tells whether a path is one of the launcher's generated files (<data>/molten/agent-launch/).
func isLaunchFile(path string) bool {
	dir := filepath.Dir(path)
	return filepath.Base(dir) == "agent-launch" && filepath.Base(filepath.Dir(dir)) == "molten"
}

// flagValues returns the values of a flag given as `--flag value` or `--flag=value`.
func flagValues(args []string, flags ...string) []string {
	var rtn []string
	for i := 0; i < len(args); i++ {
		for _, flag := range flags {
			if args[i] == flag && i+1 < len(args) {
				rtn = append(rtn, args[i+1])
				continue
			}
			if strings.HasPrefix(args[i], flag+"=") {
				rtn = append(rtn, strings.TrimPrefix(args[i], flag+"="))
			}
		}
	}
	return rtn
}

// IntegrationInArgs reads a running agent's arguments (the agent's own, after its interpreter when it has one).
func IntegrationInArgs(agent string, args []string) ArgsIntegration {
	var rtn ArgsIntegration
	switch agent {
	case ClaudeAgentId:
		for _, v := range flagValues(args, claudeMcpConfigFlag) {
			if isLaunchFile(v) && strings.HasPrefix(filepath.Base(v), claudeMcpFilePrefix+"-") {
				rtn.Browser = true
				rtn.Integrated = true
			}
		}
		for _, v := range flagValues(args, claudeSettingsFlag) {
			if isLaunchFile(v) {
				rtn.Integrated = true
			}
		}
	case CodexAgentId:
		browserKey := codexMcpServersKey + "." + mcpbrowser.ServerName + ".command="
		for _, v := range flagValues(args, codexConfigFlag, codexConfigLong) {
			if strings.HasPrefix(v, browserKey) {
				rtn.Browser = true
				rtn.Integrated = true
			}
			if strings.HasPrefix(v, codexNotifyKey+"=") && strings.Contains(v, `"agent","notify"`) {
				rtn.Integrated = true
			}
		}
	}
	return rtn
}
