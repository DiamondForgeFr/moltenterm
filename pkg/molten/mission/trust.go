// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The trust rule for a project's declared commands (DS-MC-005), as for mods (FR-MORPH-004): MoltenTerm runs them
// only after the user trusted them, and asks again whenever they change. Trust is a hash of every command the pipeline
// declares, recorded per project folder.

const TrustFileName = "trust.json"

type TrustedCommand struct {
	Kind  string            `json:"kind"`
	Id    string            `json:"id"`
	Title string            `json:"title,omitempty"`
	Run   string            `json:"run"`
	Cwd   string            `json:"cwd,omitempty"`
	Env   map[string]string `json:"env,omitempty"`
}

type UntrustedInfo struct {
	Hash     string           `json:"hash"`
	Commands []TrustedCommand `json:"commands"`
}

// PipelineCommands lists every command a pipeline declares, in a stable order.
func PipelineCommands(p *molten.Pipeline) []TrustedCommand {
	var rtn []TrustedCommand
	if p == nil {
		return rtn
	}
	if p.Ci != nil {
		for _, job := range p.Ci.Jobs {
			rtn = append(rtn, TrustedCommand{Kind: "ci", Id: job.Name, Title: job.Title, Run: job.Run, Cwd: job.Cwd, Env: job.Env})
		}
	}
	for _, build := range p.Builds {
		rtn = append(rtn, TrustedCommand{Kind: "build", Id: build.Id, Title: build.Title, Run: build.Run, Cwd: build.Cwd, Env: build.Env})
	}
	if p.Release != nil {
		for _, step := range p.Release.Rc {
			rtn = append(rtn, TrustedCommand{Kind: "rc", Id: step.Id, Title: step.Title, Run: step.Run, Cwd: step.Cwd, Env: step.Env})
		}
		for _, step := range p.Release.Public {
			rtn = append(rtn, TrustedCommand{Kind: "public", Id: step.Id, Title: step.Title, Run: step.Run, Cwd: step.Cwd, Env: step.Env})
		}
	}
	for _, step := range p.Steps {
		rtn = append(rtn, TrustedCommand{Kind: "step", Id: step.Id, Title: step.Title, Run: step.Run, Cwd: step.Cwd, Env: step.Env})
	}
	return rtn
}

// CommandsHash changes whenever a command, its folder or its environment changes; titles do not count.
func CommandsHash(commands []TrustedCommand) string {
	type key struct {
		Kind string            `json:"kind"`
		Id   string            `json:"id"`
		Run  string            `json:"run"`
		Cwd  string            `json:"cwd"`
		Env  map[string]string `json:"env"`
	}
	keys := make([]key, 0, len(commands))
	for _, c := range commands {
		keys = append(keys, key{Kind: c.Kind, Id: c.Id, Run: c.Run, Cwd: c.Cwd, Env: c.Env})
	}
	sort.SliceStable(keys, func(i, j int) bool {
		if keys[i].Kind != keys[j].Kind {
			return keys[i].Kind < keys[j].Kind
		}
		return keys[i].Id < keys[j].Id
	})
	data, _ := json.Marshal(keys)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type TrustStore struct {
	lock sync.Mutex
	file string
}

func MakeTrustStore(file string) *TrustStore {
	return &TrustStore{file: file}
}

func (t *TrustStore) readLocked() map[string]string {
	trusted := map[string]string{}
	data, err := os.ReadFile(t.file)
	if err == nil {
		json.Unmarshal(data, &trusted)
	}
	return trusted
}

func (t *TrustStore) IsTrusted(dir string, hash string) bool {
	t.lock.Lock()
	defer t.lock.Unlock()
	return hash != "" && t.readLocked()[dir] == hash
}

func (t *TrustStore) Trust(dir string, hash string) error {
	t.lock.Lock()
	defer t.lock.Unlock()
	trusted := t.readLocked()
	trusted[dir] = hash
	if err := os.MkdirAll(filepath.Dir(t.file), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(trusted, "", "  ")
	if err != nil {
		return err
	}
	tmp := t.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, t.file)
}
