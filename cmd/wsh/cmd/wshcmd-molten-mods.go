// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The file side of `molten mod` (FR-MORPH-005): the mod folders under `<config>/mods/` and the enabled state in
// `<config>/molten/mods.json`. The state lives outside the mod folders, so an agent editing a mod never enables it by
// accident; the mod host reads it (frontend/molten/molten-host.ts).

package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

const MoltenManifestFileName = "mod.json"
const MoltenTemplateMainFileName = "main.js"

// must match ModIdPattern in frontend/molten/molten-manifest.ts
var moltenModIdRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

type MoltenState struct {
	Enabled []string `json:"enabled"`
}

// Trust is recorded per mod id (FR-MORPH-004), so an agent keeps editing a trusted mod without a prompt on every
// save. It lives in the data directory, apart from the configuration that agents and dotfile managers edit.
type MoltenTrustEntry struct {
	Name      string `json:"name"`
	TrustedAt string `json:"trustedat"`
}

type MoltenTrust struct {
	Trusted map[string]MoltenTrustEntry `json:"trusted"`
}

type MoltenTemplateManifest struct {
	Id           string   `json:"id"`
	Name         string   `json:"name"`
	Version      string   `json:"version"`
	Description  string   `json:"description"`
	ApiVersion   int      `json:"apiVersion"`
	Main         string   `json:"main"`
	Capabilities []string `json:"capabilities"`
}

func moltenModsDir(configDir string) string {
	return filepath.Join(configDir, "mods")
}

func moltenStateFile(configDir string) string {
	return filepath.Join(configDir, "molten", "mods.json")
}

func moltenTrustFile(dataDir string) string {
	return filepath.Join(dataDir, "molten", "trust.json")
}

func moltenCheckModId(id string) error {
	if !moltenModIdRegex.MatchString(id) {
		return fmt.Errorf("invalid mod id %q: use lowercase letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit", id)
	}
	return nil
}

func moltenReadState(path string) (MoltenState, error) {
	var state MoltenState
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, fmt.Errorf("reading %s: %w", path, err)
	}
	if strings.TrimSpace(string(data)) == "" {
		return state, nil
	}
	err = json.Unmarshal(data, &state)
	if err != nil {
		return state, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	return state, nil
}

func moltenWriteState(path string, state MoltenState) error {
	seen := make(map[string]bool)
	enabled := []string{}
	for _, id := range state.Enabled {
		if !seen[id] {
			seen[id] = true
			enabled = append(enabled, id)
		}
	}
	sort.Strings(enabled)
	return moltenWriteJsonFile(path, MoltenState{Enabled: enabled})
}

func moltenReadTrust(path string) (MoltenTrust, error) {
	trust := MoltenTrust{Trusted: map[string]MoltenTrustEntry{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return trust, nil
	}
	if err != nil {
		return trust, fmt.Errorf("reading %s: %w", path, err)
	}
	if strings.TrimSpace(string(data)) == "" {
		return trust, nil
	}
	err = json.Unmarshal(data, &trust)
	if err != nil {
		return trust, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	if trust.Trusted == nil {
		trust.Trusted = map[string]MoltenTrustEntry{}
	}
	return trust, nil
}

func moltenIsTrusted(dataDir string, id string) (bool, error) {
	trust, err := moltenReadTrust(moltenTrustFile(dataDir))
	if err != nil {
		return false, err
	}
	_, ok := trust.Trusted[id]
	return ok, nil
}

func moltenSetTrusted(dataDir string, id string, name string, now time.Time) error {
	path := moltenTrustFile(dataDir)
	trust, err := moltenReadTrust(path)
	if err != nil {
		return err
	}
	trust.Trusted[id] = MoltenTrustEntry{Name: name, TrustedAt: now.UTC().Format(time.RFC3339)}
	return moltenWriteJsonFile(path, trust)
}

func moltenForgetTrust(dataDir string, id string) (bool, error) {
	path := moltenTrustFile(dataDir)
	trust, err := moltenReadTrust(path)
	if err != nil {
		return false, err
	}
	if _, ok := trust.Trusted[id]; !ok {
		return false, nil
	}
	delete(trust.Trusted, id)
	return true, moltenWriteJsonFile(path, trust)
}

func moltenWriteJsonFile(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	err = os.MkdirAll(filepath.Dir(path), 0755)
	if err != nil {
		return err
	}
	// Written then renamed, so the host never reads a half-written file.
	tmpPath := path + ".tmp"
	err = os.WriteFile(tmpPath, append(data, '\n'), 0644)
	if err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func moltenIsEnabled(state MoltenState, id string) bool {
	for _, enabledId := range state.Enabled {
		if enabledId == id {
			return true
		}
	}
	return false
}

func moltenSetEnabled(configDir string, id string, enabled bool) (bool, error) {
	statePath := moltenStateFile(configDir)
	state, err := moltenReadState(statePath)
	if err != nil {
		return false, err
	}
	wasEnabled := moltenIsEnabled(state, id)
	if wasEnabled == enabled {
		return false, nil
	}
	if enabled {
		state.Enabled = append(state.Enabled, id)
	} else {
		kept := []string{}
		for _, enabledId := range state.Enabled {
			if enabledId != id {
				kept = append(kept, enabledId)
			}
		}
		state.Enabled = kept
	}
	return true, moltenWriteState(statePath, state)
}

// The mod folder of an existing mod, checked so that a crafted id never reaches outside `<config>/mods/`.
func moltenExistingModDir(configDir string, id string) (string, error) {
	err := moltenCheckModId(id)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(moltenModsDir(configDir), id)
	info, err := os.Stat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("no mod %q in %s", id, moltenModsDir(configDir))
	}
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a folder", dir)
	}
	return dir, nil
}

func moltenTemplateCommandName(id string) string {
	name := strings.NewReplacer(".", "-", "_", "-").Replace(id)
	if name[0] < 'a' || name[0] > 'z' {
		name = "mod-" + name
	}
	return name
}

const moltenTemplateMainSource = `// {{name}}, a Moltenterm mod. Format and API: docs/molten/mod-format.md in the Moltenterm repository.
// Check it with "molten mod validate {{id}}", turn it on with "molten mod enable {{id}}", then run "molten {{command}}".

export function activate(api) {
    api.commands.register(
        "{{command}}",
        ({ args }) => "hello " + (args.join(" ") || "world") + " from {{id}}",
        { description: "Say hello" }
    );
}
`

func moltenTemplateMain(id string, name string) string {
	return strings.NewReplacer(
		"{{name}}", name,
		"{{id}}", id,
		"{{command}}", moltenTemplateCommandName(id),
	).Replace(moltenTemplateMainSource)
}

func moltenNewMod(configDir string, id string, name string, description string) (string, error) {
	err := moltenCheckModId(id)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(moltenModsDir(configDir), id)
	_, err = os.Stat(dir)
	if err == nil {
		return "", fmt.Errorf("mod %q already exists in %s", id, dir)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if name == "" {
		name = id
	}
	manifest := MoltenTemplateManifest{
		Id:           id,
		Name:         name,
		Version:      "0.1.0",
		Description:  description,
		ApiVersion:   1,
		Main:         MoltenTemplateMainFileName,
		Capabilities: []string{"commands"},
	}
	manifestData, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	err = os.MkdirAll(dir, 0755)
	if err != nil {
		return "", err
	}
	err = os.WriteFile(filepath.Join(dir, MoltenManifestFileName), append(manifestData, '\n'), 0644)
	if err != nil {
		return "", err
	}
	err = os.WriteFile(filepath.Join(dir, MoltenTemplateMainFileName), []byte(moltenTemplateMain(id, name)), 0644)
	if err != nil {
		return "", err
	}
	return dir, nil
}

// Until #20 brings history and undo, a removed mod goes to the system trash on macOS and to
// `<data>/molten/removed/` elsewhere, so that a wrong removal can be recovered by hand.
func moltenSystemTrashDir() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".Trash")
}

func moltenRemoveMod(configDir string, dataDir string, trashDir string, id string, now time.Time) (string, error) {
	dir, err := moltenExistingModDir(configDir, id)
	if err != nil {
		return "", err
	}
	_, err = moltenSetEnabled(configDir, id, false)
	if err != nil {
		return "", err
	}
	_, err = moltenForgetTrust(dataDir, id)
	if err != nil {
		return "", err
	}
	stamp := now.Format("2006-01-02 15.04.05")
	if trashDir != "" {
		dest := moltenFreeDest(trashDir, id, stamp)
		if os.Rename(dir, dest) == nil {
			return dest, nil
		}
	}
	removedDir := filepath.Join(dataDir, "molten", "removed")
	err = os.MkdirAll(removedDir, 0755)
	if err != nil {
		return "", err
	}
	dest := moltenFreeDest(removedDir, id, stamp)
	err = os.Rename(dir, dest)
	if err != nil {
		return "", fmt.Errorf("moving %s to %s: %w", dir, dest, err)
	}
	return dest, nil
}

func moltenFreeDest(parent string, id string, stamp string) string {
	dest := filepath.Join(parent, id)
	if _, err := os.Lstat(dest); errors.Is(err, os.ErrNotExist) {
		return dest
	}
	return filepath.Join(parent, fmt.Sprintf("%s %s", id, stamp))
}
