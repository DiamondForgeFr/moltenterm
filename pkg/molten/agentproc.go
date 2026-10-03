// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// The Processes view names coding agents by agent (FR-SHELL-011): Claude Code's process is named after its version
// (`2.1.283`, its binary being ~/.local/share/claude/versions/2.1.283), Gemini CLI's is `node`.

const agentProcCacheMax = 2048

var versionNameRegex = regexp.MustCompile(`^v?\d+\.\d+(\.\d+)?([-+.][0-9A-Za-z.-]*)?$`)

var agentRuntimes = map[string]bool{"node": true, "bun": true, "deno": true}

// AgentProcessCandidate tells whether a process name may hide an agent; only those are looked at more closely.
func AgentProcessCandidate(command string) bool {
	base := filepath.Base(command)
	return versionNameRegex.MatchString(base) || agentRuntimes[base]
}

// MatchAgentProcess returns the agent a process runs, from its executable path and arguments.
func MatchAgentProcess(exe string, args []string) string {
	text := exe + "\x00" + strings.Join(args, "\x00")
	for _, kind := range AgentKinds {
		for _, hint := range kind.ProcessHints {
			if strings.Contains(text, hint) {
				return kind.Id
			}
		}
	}
	return ""
}

// AgentProcessLabel is what the Processes view shows for an agent's process: the agent's name, with the process name
// it replaces.
func AgentProcessLabel(agentId string, command string) string {
	return AgentDisplayName(agentId) + " (" + command + ")"
}

type agentProcCache struct {
	lock    sync.Mutex
	entries map[string]string
}

var defaultAgentProcCache = &agentProcCache{entries: map[string]string{}}

func (c *agentProcCache) get(key string) (string, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	label, ok := c.entries[key]
	return label, ok
}

func (c *agentProcCache) put(key string, label string) {
	c.lock.Lock()
	defer c.lock.Unlock()
	if len(c.entries) >= agentProcCacheMax {
		c.entries = map[string]string{}
	}
	c.entries[key] = label
}

// AgentProcessCommand renames an agent's process for the Processes view. read gives the process's executable path
// and arguments; it is only called for candidates, once per process key (the view refreshes every second, so the key
// should tell a reused pid apart: pid and parent pid).
func AgentProcessCommand(procKey string, command string, read func() (string, []string)) string {
	if !AgentProcessCandidate(command) {
		return command
	}
	key := procKey + "\x00" + command
	if label, ok := defaultAgentProcCache.get(key); ok {
		return label
	}
	label := command
	exe, args := read()
	if id := MatchAgentProcess(exe, args); id != "" {
		label = AgentProcessLabel(id, command)
	}
	defaultAgentProcCache.put(key, label)
	return label
}
