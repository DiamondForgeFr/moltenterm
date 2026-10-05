// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// Using MoltenTerm means using its guides (FR-ONB-006, DS-ONB-006): at every start wavesrv installs them for each
// coding agent found on the login shell's PATH, and rewrites them when MoltenTerm's version changes. The agents the
// user removed them from with `molten agent remove` are remembered here and left alone.

const agentGuidesFileName = "agent-guides.json"

var agentGuidesLock = &sync.Mutex{}

type agentGuidesState struct {
	Declined []string `json:"declined,omitempty"`
}

type AgentSyncResult struct {
	Id  string
	Err error
}

func agentGuidesFile(dataDir string) string {
	return filepath.Join(dataDir, "molten", agentGuidesFileName)
}

func readAgentGuidesState(dataDir string) (agentGuidesState, error) {
	var state agentGuidesState
	data, err := os.ReadFile(agentGuidesFile(dataDir))
	if errors.Is(err, fs.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return state, fmt.Errorf("%s: %w", agentGuidesFile(dataDir), err)
	}
	return state, nil
}

func writeAgentGuidesState(dataDir string, state agentGuidesState) error {
	path := agentGuidesFile(dataDir)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// An unreadable file counts as no refusal: the guides are part of MoltenTerm, a broken record must not hide them.
func IsAgentDeclined(dataDir string, agentId string) bool {
	agentGuidesLock.Lock()
	defer agentGuidesLock.Unlock()
	state, err := readAgentGuidesState(dataDir)
	if err != nil {
		return false
	}
	return slices.Contains(state.Declined, agentId)
}

func SetAgentDeclined(dataDir string, agentId string, declined bool) error {
	agentGuidesLock.Lock()
	defer agentGuidesLock.Unlock()
	state, err := readAgentGuidesState(dataDir)
	if err != nil && declined {
		return err
	}
	state.Declined = slices.DeleteFunc(state.Declined, func(id string) bool { return id == agentId })
	if declined {
		state.Declined = append(state.Declined, agentId)
	}
	return writeAgentGuidesState(dataDir, state)
}

// SyncAgentGuides installs the guides for every agent found in pathList that the user did not decline and whose
// guides are missing or out of date. It returns one result per agent it installed for.
func SyncAgentGuides(env AgentEnv, version string, pathList string) []AgentSyncResult {
	var results []AgentSyncResult
	for _, profile := range AgentProfiles {
		if profile.Executable == "" || LookPathIn(profile.Executable, pathList) == "" {
			continue
		}
		if IsAgentDeclined(env.DataDir, profile.Id) || !profile.NeedsInstall(env, version) {
			continue
		}
		_, err := profile.Install(env, version)
		results = append(results, AgentSyncResult{Id: profile.Id, Err: err})
	}
	return results
}

// Reading the login shell's PATH can take seconds; the start never waits for it.
func StartAgentGuideSync() {
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:AgentGuideSync", recover())
		}()
		home, err := os.UserHomeDir()
		if err != nil {
			log.Printf("molten: agent guides not installed: %v\n", err)
			return
		}
		env := AgentEnv{Home: home, DataDir: wavebase.GetWaveDataDir(), Getenv: os.Getenv}
		for _, result := range SyncAgentGuides(env, wavebase.WaveVersion, LoginPath()) {
			if result.Err != nil {
				log.Printf("molten: agent guides for %s: %v\n", result.Id, result.Err)
				continue
			}
			log.Printf("molten: agent guides installed for %s (v%s)\n", result.Id, wavebase.WaveVersion)
		}
	}()
}
