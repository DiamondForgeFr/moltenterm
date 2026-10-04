// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agentparts holds the agent part of a morph (FR-MORPH-010, DS-MORPH-009): a mod may carry, beside its
// MoltenTerm part, a Claude Code plugin folder that runs inside the Claude Code sessions started in MoltenTerm
// terminals. It depends only on the standard library, so wavesrv (pkg/molten, pkg/shellexec) and `molten` share it.
//
// Claude Code loads the folders named in CLAUDE_CODE_PLUGIN_DIRS. A local terminal is a durable job whose
// environment is fixed when it starts and survives restarts and safe mode, so the variable never names a part
// folder: it names one fixed slot per mod, `<data>/molten/agent-parts/claude-code/<mod-id>`, a symbolic link that
// wavesrv points at the part when it may load and at a placeholder plugin (`molten-off-<mod-id>`, no hooks)
// otherwise. A terminal follows enable, disable, undo and safe mode at its next Claude Code session.
package agentparts

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const AgentClaudeCode = "claude-code"
const PluginDirsVarName = "CLAUDE_CODE_PLUGIN_DIRS"

// must match MoltentermSafeModeVarName in frontend/util/moltenterm-safemode.ts
const SafeModeVarName = "MOLTENTERM_SAFE_MODE"

const PartsDirName = "agent-parts"
const StubPrefix = "molten-off-"
const DefaultClaudeCodeFolder = "agents/claude-code"
const PluginManifestDir = ".claude-plugin"
const PluginManifestFile = "plugin.json"

// Claude Code lays its typings in `<part>/.claude-plugin/types/` each time it loads a part: they are not the mod's.
const PluginTypesDir = "types"

const modManifestFileName = "mod.json"
const stubsDirName = ".stubs"
const stateFileName = "mods.json"
const trustFileName = "trust.json"

const (
	PartStateActive    = "active"
	PartStateDisabled  = "disabled"
	PartStateUntrusted = "untrusted"
	PartStateInvalid   = "invalid"
	PartStateSafeMode  = "safemode"
)

// must match AgentFolderPattern and TargetVersionPattern in frontend/molten/molten-manifest.ts
var folderRegex = regexp.MustCompile(`^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$`)
var TargetVersionRegex = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

var SupportedAgents = []string{AgentClaudeCode}

// Slots are retargeted from the watcher and at start; one sync at a time.
var syncLock sync.Mutex

type ClaudeCodePart struct {
	Folder        string `json:"folder"`
	TargetVersion string `json:"targetVersion"`
}

type PartState struct {
	Id            string `json:"id"`
	State         string `json:"state"`
	Reason        string `json:"reason,omitempty"`
	Folder        string `json:"folder"`
	Path          string `json:"path"`
	TargetVersion string `json:"targetversion,omitempty"`
	Slot          string `json:"slot"`
}

func ModsDir(configDir string) string {
	return filepath.Join(configDir, "mods")
}

func SlotsDir(dataDir string) string {
	return filepath.Join(dataDir, "molten", PartsDirName, AgentClaudeCode)
}

func SlotPath(dataDir string, id string) string {
	return filepath.Join(SlotsDir(dataDir), id)
}

func StubDir(dataDir string, id string) string {
	return filepath.Join(SlotsDir(dataDir), stubsDirName, id)
}

func StubName(id string) string {
	return StubPrefix + id
}

// IgnoredFileName tells the files editors leave behind while saving, and hidden entries.
func IgnoredFileName(name string) bool {
	return strings.HasPrefix(name, ".") || strings.HasSuffix(name, "~") || strings.HasSuffix(name, ".swp") ||
		strings.HasSuffix(name, ".swx") || strings.HasSuffix(name, ".tmp")
}

// The hidden entries that belong to a mod: a Claude Code plugin's manifest folder and config files, and a
// `.gitignore` (the scaffold writes one in the part to keep Claude Code's typings out of git).
func keptHiddenName(name string, last bool) bool {
	if name == PluginManifestDir {
		return true
	}
	return last && (name == ".mcp.json" || name == ".lsp.json" || name == ".gitignore")
}

// IgnoredModRelPath is the single rule for the paths of a mod tree that do not count, used by the watcher and the
// history alike: hidden entries and editor droppings, except the plugin files above, and always the typings Claude
// Code writes into `.claude-plugin/types/`, so a Claude Code start never reloads a mod nor records a change.
func IgnoredModRelPath(rel string) bool {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	for i, name := range parts {
		if name == "" || name == "." {
			continue
		}
		last := i == len(parts)-1
		if name == PluginManifestDir && !last && parts[i+1] == PluginTypesDir {
			return true
		}
		if keptHiddenName(name, last) {
			continue
		}
		if IgnoredFileName(name) {
			return true
		}
	}
	return false
}

func checkFolder(folder string) error {
	if !folderRegex.MatchString(folder) {
		return fmt.Errorf("must be a relative path inside the mod folder (got %q)", folder)
	}
	for _, part := range strings.Split(folder, "/") {
		if part == "." || part == ".." {
			return fmt.Errorf("must be a relative path inside the mod folder, with no \".\" or \"..\" segment (got %q)", folder)
		}
	}
	return nil
}

// ParseAgents reads the `agents` field of a mod.json. A mod without one has no agent part (nil, nil).
func ParseAgents(manifest []byte) (*ClaudeCodePart, error) {
	var raw struct {
		Agents json.RawMessage `json:"agents"`
	}
	if err := json.Unmarshal(manifest, &raw); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", modManifestFileName, err)
	}
	if len(raw.Agents) == 0 || string(raw.Agents) == "null" {
		return nil, nil
	}
	var agents map[string]json.RawMessage
	if err := json.Unmarshal(raw.Agents, &agents); err != nil || agents == nil {
		return nil, fmt.Errorf("%s: \"agents\" must be an object keyed by agent id", modManifestFileName)
	}
	keys := make([]string, 0, len(agents))
	for key := range agents {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if key != AgentClaudeCode {
			return nil, fmt.Errorf("%s: agent %q is not supported; supported: %s", modManifestFileName, key, strings.Join(SupportedAgents, ", "))
		}
	}
	entry, ok := agents[AgentClaudeCode]
	if !ok {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(entry, &fields); err != nil || fields == nil {
		return nil, fmt.Errorf("%s: \"agents.%s\" must be an object", modManifestFileName, AgentClaudeCode)
	}
	var part ClaudeCodePart
	if json.Unmarshal(fields["folder"], &part.Folder) != nil || strings.TrimSpace(part.Folder) == "" {
		return nil, fmt.Errorf("%s: \"agents.%s.folder\" must be a non-empty string (usually %q)", modManifestFileName, AgentClaudeCode, DefaultClaudeCodeFolder)
	}
	if err := checkFolder(part.Folder); err != nil {
		return nil, fmt.Errorf("%s: \"agents.%s.folder\" %v", modManifestFileName, AgentClaudeCode, err)
	}
	if json.Unmarshal(fields["targetVersion"], &part.TargetVersion) != nil || !TargetVersionRegex.MatchString(part.TargetVersion) {
		return nil, fmt.Errorf("%s: \"agents.%s.targetVersion\" must be the Claude Code version the part was written for, as MAJOR.MINOR.PATCH (claude --version)", modManifestFileName, AgentClaudeCode)
	}
	return &part, nil
}

// ReadClaudeCodePart reads the Claude Code part a mod declares; nil, nil when it declares none or has no mod.json.
func ReadClaudeCodePart(modsDir string, id string) (*ClaudeCodePart, error) {
	data, err := os.ReadFile(filepath.Join(modsDir, id, modManifestFileName))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ParseAgents(data)
}

// CheckPartFolder checks the part folder of a mod without reading its code: it stays inside the mod once every
// symbolic link is resolved, and holds a plugin manifest named like the mod (plugin names must be unique among
// the loaded plugins). It returns the folder's path.
func CheckPartFolder(modsDir string, id string, part *ClaudeCodePart) (string, error) {
	modDir := filepath.Join(modsDir, id)
	dir := filepath.Join(modDir, filepath.FromSlash(part.Folder))
	realMod, err := filepath.EvalSymlinks(modDir)
	if err != nil {
		return dir, err
	}
	realDir, err := filepath.EvalSymlinks(dir)
	if errors.Is(err, os.ErrNotExist) {
		return dir, fmt.Errorf("the part folder %s does not exist", part.Folder)
	}
	if err != nil {
		return dir, err
	}
	rel, err := filepath.Rel(realMod, realDir)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return dir, fmt.Errorf("the part folder %s leads outside the mod folder", part.Folder)
	}
	info, err := os.Stat(realDir)
	if err != nil || !info.IsDir() {
		return dir, fmt.Errorf("the part folder %s is not a folder", part.Folder)
	}
	manifestRel := part.Folder + "/" + PluginManifestDir + "/" + PluginManifestFile
	data, err := os.ReadFile(filepath.Join(realDir, PluginManifestDir, PluginManifestFile))
	if errors.Is(err, os.ErrNotExist) {
		return dir, fmt.Errorf("%s not found", manifestRel)
	}
	if err != nil {
		return dir, err
	}
	var manifest struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return dir, fmt.Errorf("%s is not valid JSON: %v", manifestRel, err)
	}
	if manifest.Name != id {
		return dir, fmt.Errorf("%s: \"name\" is %q but must be the mod id %q", manifestRel, manifest.Name, id)
	}
	return dir, nil
}

type trustEntry struct {
	Agents []string `json:"agents"`
}

func readEnabled(configDir string) map[string]bool {
	var state struct {
		Enabled []string `json:"enabled"`
	}
	if data, err := os.ReadFile(filepath.Join(configDir, "molten", stateFileName)); err == nil {
		json.Unmarshal(data, &state)
	}
	enabled := make(map[string]bool)
	for _, id := range state.Enabled {
		enabled[id] = true
	}
	return enabled
}

// ReadTrustedParts gives, per mod id, whether the user trusted the mod and whether that trust covers its Claude
// Code part (FR-MORPH-004: the part runs inside Claude Code, so it is trusted explicitly).
func ReadTrustedParts(dataDir string) (map[string]bool, map[string]bool) {
	var trust struct {
		Trusted map[string]json.RawMessage `json:"trusted"`
	}
	if data, err := os.ReadFile(filepath.Join(dataDir, "molten", trustFileName)); err == nil {
		json.Unmarshal(data, &trust)
	}
	mods := make(map[string]bool)
	parts := make(map[string]bool)
	for id, raw := range trust.Trusted {
		mods[id] = true
		var entry trustEntry
		json.Unmarshal(raw, &entry)
		for _, agent := range entry.Agents {
			if agent == AgentClaudeCode {
				parts[id] = true
			}
		}
	}
	return mods, parts
}

func modFolderIds(modsDir string) ([]string, error) {
	entries, err := os.ReadDir(modsDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			ids = append(ids, entry.Name())
		}
	}
	sort.Strings(ids)
	return ids, nil
}

// PartStates gives the state of the Claude Code part of every mod that declares one. Only "active" loads it.
func PartStates(configDir string, dataDir string, safeMode bool) ([]PartState, error) {
	modsDir := ModsDir(configDir)
	ids, err := modFolderIds(modsDir)
	if err != nil {
		return nil, err
	}
	enabled := readEnabled(configDir)
	_, trustedParts := ReadTrustedParts(dataDir)
	states := []PartState{}
	for _, id := range ids {
		part, partErr := ReadClaudeCodePart(modsDir, id)
		if partErr == nil && part == nil {
			continue
		}
		state := PartState{Id: id, Slot: SlotPath(dataDir, id)}
		if part != nil {
			state.Folder = part.Folder
			state.TargetVersion = part.TargetVersion
			state.Path = filepath.Join(modsDir, id, filepath.FromSlash(part.Folder))
		}
		if partErr == nil {
			_, partErr = CheckPartFolder(modsDir, id, part)
		}
		switch {
		case !enabled[id]:
			state.State = PartStateDisabled
		case partErr != nil:
			state.State = PartStateInvalid
			state.Reason = partErr.Error()
		case !trustedParts[id]:
			state.State = PartStateUntrusted
			state.Reason = "the trust given to the mod does not cover its Claude Code part"
		case safeMode:
			state.State = PartStateSafeMode
		default:
			state.State = PartStateActive
		}
		states = append(states, state)
	}
	return states, nil
}

func ensureStub(dataDir string, id string) (string, error) {
	dir := StubDir(dataDir, id)
	manifest := map[string]any{
		"name":        StubName(id),
		"version":     "0.0.0",
		"description": fmt.Sprintf("MoltenTerm: the Claude Code part of mod %s is off", id),
		"author":      map[string]string{"name": "MoltenTerm"},
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	data = append(data, '\n')
	path := filepath.Join(dir, PluginManifestDir, PluginManifestFile)
	if existing, err := os.ReadFile(path); err == nil && string(existing) == string(data) {
		return dir, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return "", err
	}
	return dir, os.WriteFile(path, data, 0644)
}

// pointSlot makes the slot a symbolic link to target, atomically: a Claude Code session starting meanwhile sees the
// old target or the new one, never a missing folder.
func pointSlot(slot string, target string) (bool, error) {
	if current, err := os.Readlink(slot); err == nil && current == target {
		return false, nil
	}
	if info, err := os.Lstat(slot); err == nil && info.Mode()&os.ModeSymlink == 0 {
		return false, fmt.Errorf("%s is not a symbolic link; MoltenTerm leaves it alone", slot)
	}
	tmp := filepath.Join(filepath.Dir(slot), "."+filepath.Base(slot)+".tmp")
	os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return false, err
	}
	if err := os.Rename(tmp, slot); err != nil {
		os.Remove(tmp)
		return false, err
	}
	return true, nil
}

// SyncClaudeCodeSlots points every slot at the part it stands for, or at its placeholder. A slot whose mod no longer
// declares a part keeps pointing at a placeholder, since a running terminal may still name it; with prune (at
// start) the slots and placeholders of mods whose folder is gone are deleted. Nothing is done on Windows.
func SyncClaudeCodeSlots(configDir string, dataDir string, safeMode bool, prune bool, goos string) error {
	if goos == "windows" {
		return nil
	}
	syncLock.Lock()
	defer syncLock.Unlock()
	states, err := PartStates(configDir, dataDir, safeMode)
	if err != nil {
		return err
	}
	slotsDir := SlotsDir(dataDir)
	var errs []error
	wanted := make(map[string]bool)
	for _, state := range states {
		wanted[state.Id] = true
		if strings.Contains(state.Slot, string(os.PathListSeparator)) {
			errs = append(errs, fmt.Errorf("slot %s holds the path-list separator; the part of %s cannot be loaded", state.Slot, state.Id))
			continue
		}
		target := state.Path
		if state.State != PartStateActive {
			target, err = ensureStub(dataDir, state.Id)
			if err != nil {
				errs = append(errs, err)
				continue
			}
		}
		if err := os.MkdirAll(slotsDir, 0755); err != nil {
			return err
		}
		if changed, err := pointSlot(state.Slot, target); err != nil {
			errs = append(errs, err)
		} else if changed {
			log.Printf("molten: Claude Code part of %s: %s (slot -> %s)\n", state.Id, state.State, target)
		}
	}
	existing, _ := modFolderIds(ModsDir(configDir))
	modExists := make(map[string]bool)
	for _, id := range existing {
		modExists[id] = true
	}
	slots, _ := os.ReadDir(slotsDir)
	for _, slot := range slots {
		id := slot.Name()
		if strings.HasPrefix(id, ".") || wanted[id] {
			continue
		}
		if prune && !modExists[id] {
			os.Remove(filepath.Join(slotsDir, id))
			os.RemoveAll(StubDir(dataDir, id))
			continue
		}
		stub, err := ensureStub(dataDir, id)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if _, err := pointSlot(filepath.Join(slotsDir, id), stub); err != nil {
			errs = append(errs, err)
		}
	}
	if prune {
		stubs, _ := os.ReadDir(filepath.Join(slotsDir, stubsDirName))
		for _, stub := range stubs {
			if _, err := os.Lstat(filepath.Join(slotsDir, stub.Name())); errors.Is(err, os.ErrNotExist) {
				os.RemoveAll(filepath.Join(slotsDir, stubsDirName, stub.Name()))
			}
		}
	}
	return errors.Join(errs...)
}

// IsSlotEntry tells an entry of CLAUDE_CODE_PLUGIN_DIRS that names a MoltenTerm slot, from this MoltenTerm or from
// one that started it (a development build run from a MoltenTerm terminal).
func IsSlotEntry(entry string) bool {
	return strings.Contains(filepath.ToSlash(entry), "/molten/"+PartsDirName+"/")
}

func listSeparator(goos string) string {
	if goos == "windows" {
		return ";"
	}
	return ":"
}

// Slots lists the slots that exist, sorted.
func Slots(dataDir string) []string {
	entries, err := os.ReadDir(SlotsDir(dataDir))
	if err != nil {
		return nil
	}
	slots := []string{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		slots = append(slots, filepath.Join(SlotsDir(dataDir), entry.Name()))
	}
	sort.Strings(slots)
	return slots
}

// PluginDirsValue is CLAUDE_CODE_PLUGIN_DIRS for a local shell: the user's own entries first, kept in order, then
// every slot. Inherited slots are dropped; safe mode and Windows add none. Empty means the variable is not set.
func PluginDirsValue(inherited string, dataDir string, safeMode bool, goos string) string {
	sep := listSeparator(goos)
	seen := make(map[string]bool)
	entries := []string{}
	add := func(entry string) {
		if entry == "" || seen[entry] {
			return
		}
		seen[entry] = true
		entries = append(entries, entry)
	}
	for _, entry := range strings.Split(inherited, sep) {
		if !IsSlotEntry(entry) {
			add(entry)
		}
	}
	if !safeMode && goos != "windows" {
		for _, slot := range Slots(dataDir) {
			if strings.Contains(slot, sep) {
				log.Printf("molten: %s holds %q and cannot be listed in %s\n", slot, sep, PluginDirsVarName)
				continue
			}
			add(slot)
		}
	}
	return strings.Join(entries, sep)
}
