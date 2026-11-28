// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
)

const (
	KimiHookDefinitionVersion = 1
	// 2.7.2 (#2543): the same 11 events in its hook enum, the same strict [[hooks]] table (event, matcher, command,
	// timeout 1..600) and the same snake_case stdin payload (hook_event_name, session_id, cwd, turn_id) as 2.6.3.
	KimiHookQualifiedVersion = "2.7.2"
	kimiHookStateFileName    = "kimi-hook-installations.json"
	kimiHookStartMarker      = "# >>> MoltenTerm managed Kimi hooks — do not edit >>>"
	kimiHookEndMarker        = "# <<< MoltenTerm managed Kimi hooks <<<"
)

type kimiHookDefinition struct {
	Version int
	SHA256  string
	Events  []string
	Block   string
}

type kimiInstallation struct {
	ConfigPath        string `json:"configpath"`
	DefinitionVersion int    `json:"definitionversion"`
	DefinitionSHA256  string `json:"definitionsha256"`
	KimiVersion       string `json:"kimiversion"`
	BlockSHA256       string `json:"blocksha256"`
	CreatedFile       bool   `json:"createdfile,omitempty"`
}

type kimiInstallationsFile struct {
	Installations map[string]kimiInstallation `json:"installations"`
}

type kimiBlockMetadata struct {
	DefinitionVersion int
	DefinitionSHA256  string
	KimiVersion       string
	Events            string
}

type kimiConfigInspection struct {
	Path       string
	Data       []byte
	Exists     bool
	Mode       fs.FileMode
	Digest     string
	BlockStart int
	BlockEnd   int
	Block      []byte
	Metadata   kimiBlockMetadata
	HasBlock   bool
	Manual     bool
	ErrorCode  string
}

// The Kimi Code versions whose hook contract is known not to take MoltenTerm's block: the only ones kept read-only.
// Any other version that is not the qualified one is written after the developer confirms (#2543). A var for tests.
var kimiHookIncompatibleVersions = map[string]bool{}

var kimiSaveInstallations = saveKimiInstallations

// kimiHookAdapter: a managed block between markers in Kimi Code's config.toml, with an installation record that
// tells a hand-edited block (repair) from an older one (update).
type kimiHookAdapter struct{}

func (kimiHookAdapter) offer(env AgentEnv, offer AgentHookOffer, cwd string, hooked bool, detection AgentHookDetection) AgentHookOffer {
	return makeKimiAgentHookOffer(env, offer, hooked, detection)
}

func (kimiHookAdapter) mutate(env AgentEnv, req AgentHookMutationRequest, hooked bool, detection AgentHookDetection, remove bool) (AgentHookMutationResult, error) {
	return mutateKimiHooks(env, req, hooked, detection, remove)
}

func currentKimiHookDefinition() kimiHookDefinition {
	entries := AgentStateHooks(AgentIdKimi)
	canonical, _ := json.Marshal(entries)
	hash := sha256.Sum256(canonical)
	events := make([]string, 0, len(entries))
	for _, entry := range entries {
		events = append(events, entry.Event)
	}
	return kimiHookDefinition{
		Version: KimiHookDefinitionVersion,
		SHA256:  hex.EncodeToString(hash[:]),
		Events:  events,
		Block:   makeKimiManagedBlock(KimiHookDefinitionVersion, hex.EncodeToString(hash[:]), KimiHookQualifiedVersion, events, entries),
	}
}

func makeKimiManagedBlock(version int, fingerprint string, kimiVersion string, events []string, entries []AgentHookEntry) string {
	var b strings.Builder
	b.WriteString(kimiHookStartMarker + "\n")
	fmt.Fprintf(&b, "# definition-version: %d\n", version)
	fmt.Fprintf(&b, "# definition-sha256: %s\n", fingerprint)
	fmt.Fprintf(&b, "# kimi-version: %s\n", kimiVersion)
	fmt.Fprintf(&b, "# events: %s\n", strings.Join(events, ","))
	b.WriteString(kimiHooksTOML(entries))
	b.WriteString("\n" + kimiHookEndMarker)
	return b.String()
}

func kimiConfigPath(env AgentEnv) string {
	return filepath.Clean(filepath.Join(kimiCodeHome(env), "config.toml"))
}

func kimiInstallationsPath(dataDir string) string {
	return filepath.Join(dataDir, "molten", kimiHookStateFileName)
}

func readKimiInstallations(dataDir string) (kimiInstallationsFile, error) {
	rtn := kimiInstallationsFile{Installations: map[string]kimiInstallation{}}
	path := kimiInstallationsPath(dataDir)
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return rtn, nil
	}
	if err != nil {
		return rtn, err
	}
	if err := json.Unmarshal(data, &rtn); err != nil {
		return rtn, fmt.Errorf("read Kimi hook installation state: %w", err)
	}
	if rtn.Installations == nil {
		rtn.Installations = map[string]kimiInstallation{}
	}
	for key, installation := range rtn.Installations {
		if key != filepath.Clean(installation.ConfigPath) || installation.ConfigPath == "" || installation.BlockSHA256 == "" {
			return rtn, fmt.Errorf("read Kimi hook installation state: invalid installation record")
		}
	}
	return rtn, nil
}

func saveKimiInstallations(dataDir string, state kimiInstallationsFile) error {
	path := kimiInstallationsPath(dataDir)
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("Kimi hook installation state is not a regular file")
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return writeAgentHookFileAtomically(path, append(data, '\n'), 0600)
}

func digestKimiBlock(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func validKimiTOML(data []byte) bool {
	var parsed map[string]any
	return toml.Unmarshal(data, &parsed) == nil
}

func hasManualKimiHooks(data []byte) (manual bool, valid bool, conflict bool) {
	var config struct {
		Hooks []struct {
			Event   string `toml:"event"`
			Command string `toml:"command"`
		} `toml:"hooks"`
	}
	if err := toml.Unmarshal(data, &config); err != nil {
		return false, false, false
	}
	events := map[string]bool{}
	for _, hook := range config.Hooks {
		if IsAgentStateHookCommand(hook.Command) || IsAgentSessionHookCommand(hook.Command) {
			manual = true
			if events[hook.Event] {
				conflict = true
			}
			events[hook.Event] = true
		}
	}
	return manual, true, conflict
}

func inspectKimiConfig(path string) kimiConfigInspection {
	rtn := kimiConfigInspection{Path: path, BlockStart: -1, BlockEnd: -1}
	file := readAgentHookConfigFile(path)
	rtn.Data, rtn.Exists, rtn.Mode, rtn.Digest, rtn.ErrorCode = file.Data, file.Exists, file.Mode, file.Digest, file.ErrorCode
	if rtn.ErrorCode != "" || !rtn.Exists {
		return rtn
	}
	data := rtn.Data
	if !validKimiTOML(data) {
		rtn.ErrorCode = "invalid-toml"
		return rtn
	}
	starts, ends := 0, 0
	for pos := 0; pos < len(data); {
		lineEnd := bytes.IndexByte(data[pos:], '\n')
		next := len(data)
		line := data[pos:]
		if lineEnd >= 0 {
			next = pos + lineEnd + 1
			line = data[pos : pos+lineEnd]
		}
		switch strings.TrimSpace(string(line)) {
		case kimiHookStartMarker:
			starts++
			if rtn.BlockStart < 0 {
				rtn.BlockStart = pos
			}
		case kimiHookEndMarker:
			ends++
			if rtn.BlockEnd < 0 {
				rtn.BlockEnd = next
			}
		}
		pos = next
	}
	if starts != 0 || ends != 0 {
		if starts != 1 || ends != 1 || rtn.BlockStart < 0 || rtn.BlockEnd <= rtn.BlockStart {
			rtn.ErrorCode = "markers"
			return rtn
		}
		rtn.HasBlock = true
		rtn.Block = data[rtn.BlockStart:rtn.BlockEnd]
		rtn.Metadata = parseKimiBlockMetadata(rtn.Block)
		outside := append(append([]byte{}, data[:rtn.BlockStart]...), data[rtn.BlockEnd:]...)
		manual, valid, _ := hasManualKimiHooks(outside)
		if !valid {
			rtn.ErrorCode = "invalid-toml"
			return rtn
		}
		if manual {
			rtn.ErrorCode = "conflict"
			return rtn
		}
		return rtn
	}
	manual, valid, conflict := hasManualKimiHooks(data)
	if !valid {
		rtn.ErrorCode = "invalid-toml"
		return rtn
	}
	if conflict {
		rtn.ErrorCode = "conflict"
		return rtn
	}
	rtn.Manual = manual
	return rtn
}

func parseKimiBlockMetadata(block []byte) kimiBlockMetadata {
	var rtn kimiBlockMetadata
	for _, line := range strings.Split(string(block), "\n") {
		if value, ok := strings.CutPrefix(line, "# definition-version: "); ok {
			rtn.DefinitionVersion, _ = strconv.Atoi(value)
		} else if value, ok := strings.CutPrefix(line, "# definition-sha256: "); ok {
			rtn.DefinitionSHA256 = value
		} else if value, ok := strings.CutPrefix(line, "# kimi-version: "); ok {
			rtn.KimiVersion = value
		} else if value, ok := strings.CutPrefix(line, "# events: "); ok {
			rtn.Events = value
		}
	}
	return rtn
}

func completeKimiBlockMetadata(metadata kimiBlockMetadata) bool {
	return metadata.DefinitionVersion > 0 && len(metadata.DefinitionSHA256) == 64 && metadata.KimiVersion != "" && metadata.Events != ""
}

func kimiUpdateKey(offer AgentHookOffer) string {
	key, _ := json.Marshal(struct {
		Status                     string
		Action                     string
		UpdateKind                 string
		File                       string
		DefinitionVersion          int
		DefinitionSHA256           string
		InstalledDefinitionVersion int
		InstalledDefinitionSHA256  string
		InstalledKimiVersion       string
		CurrentKimiVersion         string
		ConfigDigest               string
		ErrorCode                  string
		Unqualified                bool
	}{offer.Status, offer.Action, offer.UpdateKind, offer.File, offer.DefinitionVersion, offer.DefinitionSHA256, offer.InstalledDefinitionVersion, offer.InstalledDefinitionSHA256, offer.InstalledKimiVersion, offer.CurrentKimiVersion, offer.ConfigDigest, offer.ErrorCode, offer.Unqualified})
	hash := sha256.Sum256(key)
	return hex.EncodeToString(hash[:])
}

func makeKimiAgentHookOffer(env AgentEnv, offer AgentHookOffer, hooked bool, detection AgentHookDetection) AgentHookOffer {
	definition := currentKimiHookDefinition()
	path := kimiConfigPath(env)
	inspection := inspectKimiConfig(path)
	installations, stateErr := readKimiInstallations(env.DataDir)
	installation, hasInstallation := installations.Installations[path]
	offer.Persistent = true
	offer.DefinitionVersion = definition.Version
	offer.DefinitionSHA256 = definition.SHA256
	offer.QualifiedKimiVersion = KimiHookQualifiedVersion
	offer.Events = definition.Events
	offer.CurrentKimiVersion = detection.Version
	offer.DetectionError = detection.Reason
	offer.ConfigDigest = inspection.Digest
	offer.Managed = inspection.HasBlock || hasInstallation
	offer.InstalledDefinitionVersion = inspection.Metadata.DefinitionVersion
	offer.InstalledDefinitionSHA256 = inspection.Metadata.DefinitionSHA256
	offer.InstalledKimiVersion = inspection.Metadata.KimiVersion
	if offer.InstalledDefinitionVersion == 0 && hasInstallation {
		offer.InstalledDefinitionVersion = installation.DefinitionVersion
		offer.InstalledDefinitionSHA256 = installation.DefinitionSHA256
		offer.InstalledKimiVersion = installation.KimiVersion
	}
	qualified := detection.Installed && detection.Version == KimiHookQualifiedVersion
	// Block only what is known to fail (#2543): an unknown or newer version is written once the developer confirms.
	incompatible := detection.Installed && kimiHookIncompatibleVersions[detection.Version]

	switch {
	case stateErr != nil:
		offer.Status, offer.ErrorCode = HookStatusInvalid, "state"
	case inspection.ErrorCode != "":
		offer.Status, offer.ErrorCode = HookStatusInvalid, inspection.ErrorCode
		if inspection.ErrorCode == "conflict" {
			offer.Status = HookStatusConflict
		}
	case inspection.HasBlock && !completeKimiBlockMetadata(inspection.Metadata):
		offer.Status, offer.ErrorCode = HookStatusInvalid, "metadata"
	case inspection.HasBlock && hasInstallation && digestKimiBlock(inspection.Block) != installation.BlockSHA256:
		offer.Status, offer.Action, offer.UpdateKind = HookStatusDrift, HookActionRepair, HookUpdateRepair
		offer.CanRemove = true
	case inspection.HasBlock && !hasInstallation && inspection.Metadata.DefinitionSHA256 == definition.SHA256 && string(inspection.Block) != definition.Block+"\n":
		offer.Status, offer.Action, offer.UpdateKind = HookStatusDrift, HookActionRepair, HookUpdateRepair
		offer.CanRemove = true
	case !inspection.HasBlock && hasInstallation && inspection.Manual:
		offer.Status, offer.ErrorCode = HookStatusConflict, "conflict"
	case !inspection.HasBlock && hasInstallation:
		offer.Status, offer.Action, offer.UpdateKind = HookStatusDrift, HookActionRepair, HookUpdateRepair
	case inspection.HasBlock:
		offer.CanRemove = true
		if incompatible {
			offer.Status, offer.Action, offer.UpdateKind = HookStatusCompatibilityReview, HookActionReview, HookUpdateCompatibility
		} else if string(inspection.Block) != definition.Block+"\n" {
			offer.Status, offer.Action, offer.UpdateKind = HookStatusDefinitionUpdate, HookActionUpdate, HookUpdateDefinition
		} else if hooked {
			offer.Status, offer.Action, offer.Reason = HookStatusReporting, HookActionRemove, HookOfferHooked
		} else {
			offer.Status, offer.Action = HookStatusNotReporting, HookActionRemove
		}
	case inspection.Manual:
		offer.Status, offer.Reason = HookStatusManual, HookOfferConfigured
	case incompatible:
		offer.Status, offer.Action, offer.UpdateKind = HookStatusCompatibilityReview, HookActionReview, HookUpdateCompatibility
	default:
		offer.Status, offer.Action = HookStatusAbsent, HookActionInstall
	}
	if (offer.Action == HookActionInstall || offer.Action == HookActionUpdate || offer.Action == HookActionRepair) && !incompatible && offer.ErrorCode == "" {
		offer.CanApply = true
		offer.Unqualified = !qualified
	}
	if offer.Action == HookActionUpdate || offer.Action == HookActionRepair {
		offer.Changes = kimiBlockChanges(inspection.HasBlock, inspection.Block, inspection.Metadata, definition)
	}
	offer.UpdateKey = kimiUpdateKey(offer)
	return decideHookOfferShow(env, AgentIdKimi, "", hooked, offer, nil)
}

func mutateKimiHooks(env AgentEnv, req AgentHookMutationRequest, hooked bool, detection AgentHookDetection, remove bool) (AgentHookMutationResult, error) {
	path := kimiConfigPath(env)
	lock := agentHookConfigLock(path)
	lock.Lock()
	defer lock.Unlock()
	offer := MakeAgentHookOfferDetected(env, AgentIdKimi, "", hooked, detection)
	if req.ExpectedDigest == "" || req.UpdateKey == "" || offer.ConfigDigest != req.ExpectedDigest || offer.UpdateKey != req.UpdateKey {
		return AgentHookMutationResult{Offer: offer}, fmt.Errorf("stale Kimi hook approval: review the current configuration")
	}
	if remove {
		if req.Action != HookActionRemove || !offer.CanRemove {
			return AgentHookMutationResult{Offer: offer}, fmt.Errorf("Kimi hooks cannot be safely removed in this state")
		}
	} else if req.Action != offer.Action || !offer.CanApply || (req.Action != HookActionInstall && req.Action != HookActionUpdate && req.Action != HookActionRepair) {
		return AgentHookMutationResult{Offer: offer}, fmt.Errorf("Kimi hooks cannot be applied in this state")
	} else if offer.Unqualified && !req.ConfirmUnqualified {
		return AgentHookMutationResult{Offer: offer}, fmt.Errorf("this Kimi Code version is not qualified yet: confirm the risk before MoltenTerm writes its hooks")
	}
	inspection := inspectKimiConfig(path)
	if inspection.ErrorCode != "" || inspection.Digest != req.ExpectedDigest {
		return AgentHookMutationResult{Offer: offer}, fmt.Errorf("Kimi configuration changed or is unsafe")
	}
	installations, err := readKimiInstallations(env.DataDir)
	if err != nil {
		return AgentHookMutationResult{Offer: offer}, err
	}
	installation, hasInstallation := installations.Installations[path]
	definition := currentKimiHookDefinition()
	var next []byte
	var nextInstallation kimiInstallation
	deleteInstallation := false
	removeCreatedFile := false
	if remove {
		if !inspection.HasBlock || !completeKimiBlockMetadata(inspection.Metadata) {
			return AgentHookMutationResult{Offer: offer}, fmt.Errorf("Kimi managed block is not complete")
		}
		next = append(append([]byte{}, inspection.Data[:inspection.BlockStart]...), inspection.Data[inspection.BlockEnd:]...)
		if !validKimiTOML(next) {
			return AgentHookMutationResult{Offer: offer}, fmt.Errorf("removing Kimi managed block would make invalid TOML")
		}
		deleteInstallation = true
		removeCreatedFile = hasInstallation && installation.CreatedFile && len(next) == 0
	} else {
		block := []byte(definition.Block + "\n")
		if inspection.HasBlock {
			next = append([]byte{}, inspection.Data[:inspection.BlockStart]...)
			next = append(next, block...)
			next = append(next, inspection.Data[inspection.BlockEnd:]...)
		} else {
			next = append([]byte{}, inspection.Data...)
			if len(next) > 0 && next[len(next)-1] != '\n' {
				next = append(next, '\n')
			}
			if len(next) > 0 {
				next = append(next, '\n')
			}
			next = append(next, block...)
		}
		if !validKimiTOML(next) {
			return AgentHookMutationResult{Offer: offer}, fmt.Errorf("Kimi hook mutation would make invalid TOML")
		}
		nextInstallation = kimiInstallation{ConfigPath: path, DefinitionVersion: definition.Version, DefinitionSHA256: definition.SHA256, KimiVersion: KimiHookQualifiedVersion, BlockSHA256: digestKimiBlock(block), CreatedFile: !inspection.Exists || hasInstallation && installation.CreatedFile}
	}
	backupPath := ""
	if inspection.Exists {
		backupPath, err = agentHookBackup(path, inspection.Data, inspection.Mode)
		if err != nil {
			return AgentHookMutationResult{Offer: offer}, fmt.Errorf("back up Kimi configuration: %w", err)
		}
	}
	mode := inspection.Mode
	if mode == 0 {
		mode = 0600
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return AgentHookMutationResult{Offer: offer, BackupPath: backupPath}, err
	}
	if removeCreatedFile {
		err = os.Remove(path)
	} else {
		err = agentHookWriteFile(path, next, mode)
	}
	if err != nil {
		return AgentHookMutationResult{Offer: offer, BackupPath: backupPath}, fmt.Errorf("write Kimi configuration: %w", err)
	}
	if deleteInstallation {
		delete(installations.Installations, path)
	} else {
		installations.Installations[path] = nextInstallation
	}
	if err := kimiSaveInstallations(env.DataDir, installations); err != nil {
		rollbackErr := rollbackKimiConfig(path, inspection, removeCreatedFile)
		if rollbackErr != nil {
			return AgentHookMutationResult{Offer: offer, BackupPath: backupPath}, fmt.Errorf("save Kimi hook state: %v; roll back configuration: %w (backup %s)", err, rollbackErr, backupPath)
		}
		if backupPath != "" {
			return AgentHookMutationResult{Offer: offer, BackupPath: backupPath}, fmt.Errorf("save Kimi hook state: %w; configuration rolled back (backup %s)", err, backupPath)
		}
		return AgentHookMutationResult{Offer: offer, BackupPath: backupPath}, fmt.Errorf("save Kimi hook state: %w; configuration rolled back", err)
	}
	refreshed := MakeAgentHookOfferDetected(env, AgentIdKimi, "", hooked, detection)
	return AgentHookMutationResult{Offer: refreshed, BackupPath: backupPath}, nil
}

func rollbackKimiConfig(path string, before kimiConfigInspection, removed bool) error {
	if !before.Exists {
		if removed {
			return nil
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	return agentHookWriteFile(path, before.Data, before.Mode)
}
