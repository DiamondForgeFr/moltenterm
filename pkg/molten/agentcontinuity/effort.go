// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Effort levels (#549): the levels the command panel offers for the running model, and how each agent takes them.
// Claude Code: `/effort <level>` (code.claude.com/docs/en/model-config; Opus 4.6 and Sonnet 4.6 have no xhigh, an
// unsupported level falls back to the highest one below it). Codex: its reasoning shortcuts step through the efforts
// the model advertises in models_cache.json, the plain ones first, then max (tui/src/chatwidget/reasoning_shortcuts.rs
// and model_popups.rs, codex-cli 0.162.0); ultra needs Codex's own picker and is never offered.

// must match frontend/moltenterm-shell/command-panel/agent-commands.ts
const (
	EffortLow    = "low"
	EffortMedium = "medium"
	EffortHigh   = "high"
	EffortXHigh  = "xhigh"
	EffortMax    = "max"

	codexEffortUltra = "ultra"
	maxCodexEfforts  = 12
)

var claudeEfforts = []string{EffortLow, EffortMedium, EffortHigh, EffortXHigh, EffortMax}

// The Claude models whose effort stops at high below max (no xhigh).
var claudeNoXHighModels = []string{"opus-4-6", "sonnet-4-6"}

// Codex's advanced efforts, which its shortcuts walk after the others.
var codexAdvancedEfforts = []string{EffortMax, codexEffortUltra}

// The tui.keymap entries that move Codex's effort shortcuts away from their defaults.
var codexEffortKeymapKeys = []string{"increase_reasoning_effort", "decrease_reasoning_effort"}

// EffortLevels is what an agent's effort command takes for a model, nil for an agent without one.
func EffortLevels(env ModelEnv, agent string, model string) []string {
	switch agent {
	case molten.AgentIdClaude:
		return ClaudeEffortLevels(model)
	case molten.AgentIdCodex:
		return CodexEffortLevels(env, model)
	}
	return nil
}

// EffortKeysRemapped tells whether the user moved an agent's effort keys away from those MoltenTerm presses.
func EffortKeysRemapped(env ModelEnv, agent string) bool {
	return agent == molten.AgentIdCodex && CodexEffortKeysRemapped(env)
}

// ClaudeEffortLevels is what `/effort` takes for a model; model "" (not reported yet) gets every level.
func ClaudeEffortLevels(model string) []string {
	m := strings.ToLower(model)
	for _, id := range claudeNoXHighModels {
		if strings.Contains(m, id) {
			return slices.DeleteFunc(slices.Clone(claudeEfforts), func(e string) bool { return e == EffortXHigh })
		}
	}
	return slices.Clone(claudeEfforts)
}

// ValidClaudeEffort tells whether `/effort` takes the level.
func ValidClaudeEffort(level string) bool {
	return slices.Contains(claudeEfforts, level)
}

type codexEffortCache struct {
	Models []struct {
		Slug      string `json:"slug"`
		Supported []struct {
			Effort string `json:"effort"`
		} `json:"supported_reasoning_levels"`
	} `json:"models"`
}

// The models cache is a few hundred KB, read again only when it changes: the open command panel asks once a second.
type codexEffortMemo struct {
	lock   sync.Mutex
	path   string
	mod    time.Time
	size   int64
	levels map[string][]string
}

var codexEfforts = &codexEffortMemo{}

func (c *codexEffortMemo) get(path string) map[string][]string {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	c.lock.Lock()
	defer c.lock.Unlock()
	if c.levels != nil && c.path == path && c.mod.Equal(info.ModTime()) && c.size == info.Size() {
		return c.levels
	}
	c.path, c.mod, c.size, c.levels = path, info.ModTime(), info.Size(), readCodexEffortCache(path)
	return c.levels
}

func readCodexEffortCache(path string) map[string][]string {
	rtn := map[string][]string{}
	data, err := readBoundedFile(path, maxCodexFileBytes)
	if err != nil {
		return rtn
	}
	var cache codexEffortCache
	if json.Unmarshal(data, &cache) != nil {
		return rtn
	}
	for _, m := range cache.Models {
		if !ValidModelId(m.Slug) {
			continue
		}
		var advertised []string
		for _, s := range m.Supported {
			if ValidModelId(s.Effort) && !slices.Contains(advertised, s.Effort) {
				advertised = append(advertised, s.Effort)
			}
		}
		rtn[m.Slug] = codexShortcutOrder(advertised)
	}
	return rtn
}

// CodexEffortLevels lists the efforts Codex's shortcuts walk for a model, in their order, ultra left out; nil when
// the model is not in Codex's models cache.
func CodexEffortLevels(env ModelEnv, model string) []string {
	if model == "" {
		return nil
	}
	return slices.Clone(codexEfforts.get(filepath.Join(molten.CodexHome(env), codexModelsFile))[model])
}

// codexShortcutOrder is reasoning_choices: the plain efforts in the advertised order, then max; ultra is dropped.
func codexShortcutOrder(advertised []string) []string {
	var plain, advanced []string
	for _, e := range advertised {
		if slices.Contains(codexAdvancedEfforts, e) {
			if e != codexEffortUltra {
				advanced = append(advanced, e)
			}
			continue
		}
		plain = append(plain, e)
	}
	rtn := append(plain, advanced...)
	if len(rtn) > maxCodexEfforts {
		rtn = rtn[:maxCodexEfforts]
	}
	return rtn
}

// CodexEffortKeysRemapped tells whether the user's config.toml names its own keys for the effort shortcuts, which
// MoltenTerm then does not press. Read as text: a mention is enough to stay away.
func CodexEffortKeysRemapped(env ModelEnv) bool {
	data, err := readBoundedFile(filepath.Join(molten.CodexHome(env), codexConfigFile), maxCodexFileBytes)
	if err != nil {
		return false
	}
	text := string(data)
	for _, key := range codexEffortKeymapKeys {
		if strings.Contains(text, key) {
			return true
		}
	}
	return false
}
