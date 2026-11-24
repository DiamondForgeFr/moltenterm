// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// A coding agent's SaaSFoundryAI identity (#2514). SaaSFoundryAI names each coding agent by the id of its agent catalog
// (`saasfoundryai agents catalog --json`) and refuses every other name: `sf agents route --provider kimi-code` fails,
// `--provider kimi` routes. MoltenTerm's own agent ids (AgentKinds: claude, codex, kimi...) stay what they are, in its
// state, hooks and usage; only the identity handed to a session for SaaSFoundryAI goes through this mapping. A session
// never has to infer it from the agent's name or folders: MoltenTerm sets SfAgentEnvVar on the agents it starts, and
// `molten agent identity` answers for any agent from the process it runs in.

const (
	// SfAgentEnvVar holds the SaaSFoundryAI identity of the agent MoltenTerm started: set by the agent launcher on the
	// agent's process, and on the terminals MoltenTerm opens for an agent.
	SfAgentEnvVar = "MOLTENTERM_SF_AGENT"
	// SfProgramName is SaaSFoundryAI's own command name. Its package also installs `sf`, a name another vendor's CLI
	// uses: only this one counts.
	SfProgramName = "saasfoundryai"

	sfCatalogCacheName = "sf-agents.json"
	sfCatalogTimeout   = 10 * time.Second
	sfCatalogMaxBytes  = 1 << 20
)

// SfAgentProfile is one coding agent of SaaSFoundryAI's catalog: its registered id and its display name.
type SfAgentProfile struct {
	Id          string `json:"id"`
	DisplayName string `json:"displayname"`
}

// sfAgentFallback is the mapping when SaaSFoundryAI's catalog cannot be read, checked against `saasfoundryai agents
// catalog --json` (1.0.0) on 2026-11-24. The other agents have no SaaSFoundryAI profile.
var sfAgentFallback = map[string]string{
	AgentIdClaude: "claude-code",
	AgentIdCodex:  "codex",
	AgentIdKimi:   "kimi",
	AgentIdGemini: "gemini-cli",
	AgentIdQwen:   "qwen-code",
}

var sfCatalogLock = &sync.Mutex{}
var sfCatalog []SfAgentProfile

// ParseSfCatalog reads the profiles of `saasfoundryai agents catalog --json`; a profile without a valid id is left out.
func ParseSfCatalog(data []byte) ([]SfAgentProfile, error) {
	var catalog struct {
		Profiles []struct {
			Id          string `json:"id"`
			DisplayName string `json:"displayName"`
		} `json:"profiles"`
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		return nil, fmt.Errorf("SaaSFoundryAI's agent catalog could not be read: %w", err)
	}
	var rtn []SfAgentProfile
	for _, p := range catalog.Profiles {
		if !agentIdRegex.MatchString(p.Id) {
			continue
		}
		rtn = append(rtn, SfAgentProfile{Id: p.Id, DisplayName: strings.TrimSpace(p.DisplayName)})
	}
	if len(rtn) == 0 {
		return nil, errors.New("SaaSFoundryAI's agent catalog lists no coding agent")
	}
	return rtn, nil
}

// SfAgentIdIn is the SaaSFoundryAI identity of a MoltenTerm agent id. With a catalog: the profile whose display name is
// the agent's name, else the built-in id when the catalog lists it, else none (SaaSFoundryAI does not know the
// agent). Without one: the built-in mapping. "" when the agent has no identity.
func SfAgentIdIn(agentId string, catalog []SfAgentProfile) string {
	fallback := sfAgentFallback[agentId]
	if len(catalog) == 0 {
		return fallback
	}
	if kind := FindAgentKind(agentId); kind != nil {
		for _, p := range catalog {
			if p.DisplayName != "" && strings.EqualFold(p.DisplayName, kind.Name) {
				return p.Id
			}
		}
	}
	for _, p := range catalog {
		if fallback != "" && p.Id == fallback {
			return p.Id
		}
	}
	return ""
}

// SfAgentId is SfAgentIdIn with the catalog this process last read (SetSfCatalog), the built-in mapping before.
func SfAgentId(agentId string) string {
	return SfAgentIdIn(agentId, getSfCatalog())
}

// SfAgentEnv is the environment entry that hands an agent its identity, nil when it has none.
func SfAgentEnv(agentId string) []string {
	id := SfAgentId(agentId)
	if id == "" {
		return nil
	}
	return []string{SfAgentEnvVar + "=" + id}
}

// WithSfAgentEnv sets the agent's identity in an environment list, replacing the one it inherited: an agent started by
// another agent's shell tool would otherwise carry the other one's. An agent without an identity gets none.
func WithSfAgentEnv(env []string, agentId string, catalog []SfAgentProfile) []string {
	rtn := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if !strings.HasPrefix(entry, SfAgentEnvVar+"=") {
			rtn = append(rtn, entry)
		}
	}
	if id := SfAgentIdIn(agentId, catalog); id != "" {
		rtn = append(rtn, SfAgentEnvVar+"="+id)
	}
	return rtn
}

func getSfCatalog() []SfAgentProfile {
	sfCatalogLock.Lock()
	defer sfCatalogLock.Unlock()
	return sfCatalog
}

// SetSfCatalog sets the catalog SfAgentId reads in this process.
func SetSfCatalog(profiles []SfAgentProfile) {
	sfCatalogLock.Lock()
	defer sfCatalogLock.Unlock()
	sfCatalog = profiles
}

func sfCatalogCachePath(dataDir string) string {
	return filepath.Join(dataDir, "molten", sfCatalogCacheName)
}

// ReadSfCatalogCache reads the catalog wavesrv last saved, for the agent launcher, which cannot wait for SaaSFoundryAI.
func ReadSfCatalogCache(dataDir string) ([]SfAgentProfile, error) {
	data, err := os.ReadFile(sfCatalogCachePath(dataDir))
	if err != nil {
		return nil, err
	}
	var profiles []SfAgentProfile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return nil, err
	}
	var rtn []SfAgentProfile
	for _, p := range profiles {
		if agentIdRegex.MatchString(p.Id) {
			rtn = append(rtn, p)
		}
	}
	return rtn, nil
}

// WriteSfCatalogCache saves the catalog where ReadSfCatalogCache finds it.
func WriteSfCatalogCache(dataDir string, profiles []SfAgentProfile) error {
	path := sfCatalogCachePath(dataDir)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(profiles, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// LoadSfCatalog runs SaaSFoundryAI's catalog command found on pathList; an error when it is not installed or fails.
func LoadSfCatalog(ctx context.Context, pathList string) ([]SfAgentProfile, error) {
	program := LookPathIn(SfProgramName, pathList)
	if program == "" {
		return nil, fmt.Errorf("%s is not installed", SfProgramName)
	}
	ctx, cancel := context.WithTimeout(ctx, sfCatalogTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, "agents", "catalog", "--json")
	cmd.Env = append(os.Environ(), "PATH="+pathList)
	var out limitedBuffer
	out.max = sfCatalogMaxBytes
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s agents catalog: %w", SfProgramName, err)
	}
	return ParseSfCatalog(out.data)
}

// RefreshSfCatalog reads SaaSFoundryAI's catalog, keeps it for this process and saves it for the launcher. When it
// cannot be read, the saved one is kept for this process, else the built-in mapping applies.
func RefreshSfCatalog(ctx context.Context, dataDir string, pathList string) error {
	profiles, err := LoadSfCatalog(ctx, pathList)
	if err != nil {
		if cached, cerr := ReadSfCatalogCache(dataDir); cerr == nil {
			SetSfCatalog(cached)
		}
		return err
	}
	SetSfCatalog(profiles)
	return WriteSfCatalogCache(dataDir, profiles)
}

type limitedBuffer struct {
	data []byte
	max  int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(b.data)+len(p) > b.max {
		return 0, errors.New("output too large")
	}
	b.data = append(b.data, p...)
	return len(p), nil
}
