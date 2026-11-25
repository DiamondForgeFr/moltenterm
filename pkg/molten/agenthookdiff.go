// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
)

// What differs between the MoltenTerm hooks an agent's configuration holds and the ones this version ships (#2543):
// the hooks dialog lists it, so an update is never offered blind.

const (
	HookChangeAdded   = "added"
	HookChangeRemoved = "removed"
	HookChangeChanged = "changed"

	HookFieldCommand          = "command"
	HookFieldTimeout          = "timeout"
	HookFieldMatcher          = "matcher"
	HookFieldDefinition       = "definition"
	HookFieldQualifiedVersion = "qualifiedversion"
	// The managed block's text differs while its hooks and versions match (an edited fingerprint or events line).
	HookFieldBlock = "block"
)

// AgentHookChange is one difference between the installed hooks and the available ones. Installed and Available are
// the field's values; an empty timeout is the agent's default.
type AgentHookChange struct {
	Kind      string `json:"kind"`
	Event     string `json:"event,omitempty"`
	Field     string `json:"field,omitempty"`
	Installed string `json:"installed,omitempty"`
	Available string `json:"available,omitempty"`
}

func hookTimeoutText(timeout int) string {
	if timeout <= 0 {
		return ""
	}
	return strconv.Itoa(timeout)
}

// diffAgentHookEntries lists the events added, removed or changed, in the available order first, then the installed
// events this version no longer ships. One entry per event: a duplicate is a conflict handled before this is asked.
func diffAgentHookEntries(installed []AgentHookEntry, available []AgentHookEntry) []AgentHookChange {
	byEvent := map[string]AgentHookEntry{}
	for _, entry := range installed {
		if _, ok := byEvent[entry.Event]; !ok {
			byEvent[entry.Event] = entry
		}
	}
	var rtn []AgentHookChange
	shipped := map[string]bool{}
	for _, want := range available {
		shipped[want.Event] = true
		have, ok := byEvent[want.Event]
		if !ok {
			rtn = append(rtn, AgentHookChange{Kind: HookChangeAdded, Event: want.Event})
			continue
		}
		if have.Matcher != want.Matcher {
			rtn = append(rtn, AgentHookChange{Kind: HookChangeChanged, Event: want.Event, Field: HookFieldMatcher, Installed: have.Matcher, Available: want.Matcher})
		}
		if have.Command != want.Command {
			rtn = append(rtn, AgentHookChange{Kind: HookChangeChanged, Event: want.Event, Field: HookFieldCommand, Installed: have.Command, Available: want.Command})
		}
		if have.Timeout != want.Timeout {
			rtn = append(rtn, AgentHookChange{Kind: HookChangeChanged, Event: want.Event, Field: HookFieldTimeout, Installed: hookTimeoutText(have.Timeout), Available: hookTimeoutText(want.Timeout)})
		}
	}
	reported := map[string]bool{}
	for _, entry := range installed {
		if shipped[entry.Event] || reported[entry.Event] {
			continue
		}
		reported[entry.Event] = true
		rtn = append(rtn, AgentHookChange{Kind: HookChangeRemoved, Event: entry.Event})
	}
	return rtn
}

// kimiBlockEntries reads the [[hooks]] of a managed block; the block is TOML of its own.
func kimiBlockEntries(block []byte) []AgentHookEntry {
	var config struct {
		Hooks []struct {
			Event   string `toml:"event"`
			Matcher string `toml:"matcher"`
			Command string `toml:"command"`
			Timeout int    `toml:"timeout"`
		} `toml:"hooks"`
	}
	if err := toml.Unmarshal(block, &config); err != nil {
		return nil
	}
	rtn := make([]AgentHookEntry, 0, len(config.Hooks))
	for _, hook := range config.Hooks {
		rtn = append(rtn, AgentHookEntry{Event: hook.Event, Matcher: hook.Matcher, Command: hook.Command, Timeout: hook.Timeout})
	}
	return rtn
}

// kimiBlockChanges compares an installed managed block with the one this version writes. present: a block is in the
// file; a deleted block lists every event as added.
func kimiBlockChanges(present bool, block []byte, metadata kimiBlockMetadata, definition kimiHookDefinition) []AgentHookChange {
	available := AgentStateHooks(AgentIdKimi)
	if !present {
		return diffAgentHookEntries(nil, available)
	}
	var rtn []AgentHookChange
	if metadata.DefinitionVersion != definition.Version {
		rtn = append(rtn, AgentHookChange{Kind: HookChangeChanged, Field: HookFieldDefinition, Installed: strconv.Itoa(metadata.DefinitionVersion), Available: strconv.Itoa(definition.Version)})
	}
	if metadata.KimiVersion != KimiHookQualifiedVersion {
		rtn = append(rtn, AgentHookChange{Kind: HookChangeChanged, Field: HookFieldQualifiedVersion, Installed: metadata.KimiVersion, Available: KimiHookQualifiedVersion})
	}
	rtn = append(rtn, diffAgentHookEntries(kimiBlockEntries(block), available)...)
	if len(rtn) == 0 && string(block) != definition.Block+"\n" {
		rtn = append(rtn, AgentHookChange{Kind: HookChangeChanged, Field: HookFieldBlock})
	}
	return rtn
}

// jsonHookEntries reads MoltenTerm's hooks from a Claude Code settings file or a Codex hooks.json (the same shape).
// ok is false when the file is missing, does not parse or runs none of MoltenTerm's hooks.
func jsonHookEntries(path string) ([]AgentHookEntry, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var settings struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Command string `json:"command"`
				Timeout int    `json:"timeout"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, false
	}
	var rtn []AgentHookEntry
	for event, groups := range settings.Hooks {
		for _, group := range groups {
			for _, hook := range group.Hooks {
				if IsAgentStateHookCommand(hook.Command) || IsAgentSessionHookCommand(hook.Command) {
					rtn = append(rtn, AgentHookEntry{Event: event, Matcher: group.Matcher, Command: hook.Command, Timeout: hook.Timeout})
				}
			}
		}
	}
	// The map has no order; the update key hashes the changes, so they must come out the same every time.
	slices.SortStableFunc(rtn, func(a, b AgentHookEntry) int { return strings.Compare(a.Event, b.Event) })
	return rtn, len(rtn) > 0
}

// manualHookChanges: what a Claude Code or Codex user file holding MoltenTerm's hooks lacks against this version's
// recipe. Nil when the file holds none or holds the current ones.
func manualHookChanges(agent string, path string) []AgentHookChange {
	installed, ok := jsonHookEntries(path)
	if !ok {
		return nil
	}
	return diffAgentHookEntries(installed, AgentStateHooks(agent))
}

func manualHookUpdateKey(agent string, file string, changes []AgentHookChange) string {
	key, _ := json.Marshal(struct {
		Agent   string
		File    string
		Changes []AgentHookChange
	}{agent, file, changes})
	hash := sha256.Sum256(key)
	return hex.EncodeToString(hash[:])
}
