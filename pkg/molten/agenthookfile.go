// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/filebackup"
)

// The one hook offer and apply flow every provider shares (#2595): an adapter per provider knows its file and its
// format (Kimi Code's managed TOML block, the hooks object of Claude Code's settings.json and Codex's hooks.json); the
// reading, the digest that refuses a file changed since the offer, the backup, the atomic write and the show rules
// are the same for all. Nothing here runs unless the developer clicked Apply or Remove on the diff they saw: the
// commands are the windows' only (attention/agentroute.go).

const maxAgentHookConfigBytes = 4 * 1024 * 1024

// Vars so tests keep backups and failed writes in their temp folder.
var agentHookBackup = filebackup.MakeFileBackupFromData
var agentHookWriteFile = writeAgentHookFileAtomically

var agentHookConfigLocks sync.Map

// agentHookAdapter is a provider's side of the flow. offer fills the persistent fields of an offer whose common
// fields are set; mutate re-reads the file under its lock, refuses a stale approval and writes after a backup.
type agentHookAdapter interface {
	offer(env AgentEnv, offer AgentHookOffer, cwd string, hooked bool, detection AgentHookDetection) AgentHookOffer
	mutate(env AgentEnv, req AgentHookMutationRequest, hooked bool, detection AgentHookDetection, remove bool) (AgentHookMutationResult, error)
}

// agentHookConfigFile is a configuration file read without following a link and without blocking on a FIFO.
type agentHookConfigFile struct {
	Path      string
	Data      []byte
	Exists    bool
	Mode      fs.FileMode
	Digest    string
	ErrorCode string
}

func digestAgentHookConfig(data []byte, exists bool) string {
	if !exists {
		return "absent"
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func readAgentHookConfigFile(path string) agentHookConfigFile {
	rtn := agentHookConfigFile{Path: path}
	pathInfo, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		rtn.Digest = digestAgentHookConfig(nil, false)
		return rtn
	}
	if err != nil {
		rtn.ErrorCode = "read-config"
		return rtn
	}
	if pathInfo.Mode()&os.ModeSymlink != 0 {
		rtn.ErrorCode = "symlink"
		return rtn
	}
	if !pathInfo.Mode().IsRegular() {
		rtn.ErrorCode = "config-type"
		return rtn
	}
	if pathInfo.Size() > maxAgentHookConfigBytes {
		rtn.ErrorCode = "config-too-large"
		return rtn
	}
	file, err := os.Open(path)
	if err != nil {
		rtn.ErrorCode = "read-config"
		return rtn
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(pathInfo, info) {
		rtn.ErrorCode = "read-config"
		return rtn
	}
	data, err := io.ReadAll(io.LimitReader(file, maxAgentHookConfigBytes+1))
	if err != nil {
		rtn.ErrorCode = "read-config"
		return rtn
	}
	if len(data) > maxAgentHookConfigBytes {
		rtn.ErrorCode = "config-too-large"
		return rtn
	}
	currentPathInfo, err := os.Lstat(path)
	if err != nil || currentPathInfo.Mode()&os.ModeSymlink != 0 || !currentPathInfo.Mode().IsRegular() || !os.SameFile(info, currentPathInfo) {
		rtn.ErrorCode = "read-config"
		return rtn
	}
	rtn.Data = data
	rtn.Exists = true
	rtn.Mode = info.Mode().Perm()
	rtn.Digest = digestAgentHookConfig(data, true)
	return rtn
}

func agentHookConfigLock(path string) *sync.Mutex {
	lock, _ := agentHookConfigLocks.LoadOrStore(path, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

// initialHookOfferRefusal: why a first setup offer stays hidden. Hooks that reported (now or in an earlier run), a
// dismissed offer, the guides removed for the agent, or hooks set up in another file it reads.
func initialHookOfferRefusal(env AgentEnv, agent string, cwd string, hooked bool, configured func(AgentEnv, string) bool) string {
	switch {
	case hooked:
		return HookOfferHooked
	case AgentHooksSeen(env.DataDir, agent):
		return HookOfferSeen
	case IsAgentHooksOfferDeclined(env.DataDir, agent):
		return HookOfferDeclined
	case guideProfileOfAgent(agent) != "" && IsAgentDeclined(env.DataDir, guideProfileOfAgent(agent)):
		return HookOfferRemoved
	case configured != nil && configured(env, cwd):
		return HookOfferConfigured
	}
	return ""
}

// decideHookOfferShow applies the show rules every provider shares to a complete offer. It never changes what the
// offer allows (CanApply, CanRemove): Integration manages the hooks whether or not a proposal shows.
func decideHookOfferShow(env AgentEnv, agent string, cwd string, hooked bool, offer AgentHookOffer, configured func(AgentEnv, string) bool) AgentHookOffer {
	offer.Show = false
	if offer.Status == HookStatusAbsent {
		if reason := initialHookOfferRefusal(env, agent, cwd, hooked, configured); reason != "" {
			offer.Reason = reason
			return offer
		}
	}
	if offer.UpdateKind != "" && IsAgentHookUpdateDeclined(env.DataDir, agent, offer.UpdateKey) {
		offer.Reason = HookOfferDeclined
		return offer
	}
	// Hooks that reported in an earlier run are the ones in the file: this run reports at its next event.
	if offer.Status == HookStatusNotReporting && AgentHooksSeen(env.DataDir, agent) {
		offer.Reason = HookOfferSeen
		return offer
	}
	offer.Show = offer.Status != HookStatusReporting && offer.Status != HookStatusManual && offer.Status != HookStatusCurrent
	return offer
}

func agentHookAdapterOf(agent string) (agentHookAdapter, error) {
	setup, ok := agentHookSetups[agent]
	if !ok || setup.adapter == nil {
		return nil, fmt.Errorf("no hook adapter for agent %q", agent)
	}
	return setup.adapter, nil
}

// ApplyAgentHookMutation writes the offer the developer approved; req.Agent is the run's agent, set by wavesrv.
func ApplyAgentHookMutation(env AgentEnv, req AgentHookMutationRequest, hooked bool, detection AgentHookDetection) (AgentHookMutationResult, error) {
	adapter, err := agentHookAdapterOf(req.Agent)
	if err != nil {
		return AgentHookMutationResult{}, err
	}
	return adapter.mutate(env, req, hooked, detection, false)
}

// RemoveAgentHookMutation removes MoltenTerm's hooks only, after a backup.
func RemoveAgentHookMutation(env AgentEnv, req AgentHookMutationRequest, hooked bool, detection AgentHookDetection) (AgentHookMutationResult, error) {
	adapter, err := agentHookAdapterOf(req.Agent)
	if err != nil {
		return AgentHookMutationResult{}, err
	}
	return adapter.mutate(env, req, hooked, detection, true)
}

func writeAgentHookFileAtomically(path string, data []byte, mode fs.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".molten-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(mode.Perm()); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}
