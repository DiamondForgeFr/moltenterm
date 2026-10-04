// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Claude Code side of `molten` (FR-MORPH-010, DS-MORPH-009). `molten` runs in the user's shell, so it finds the
// user's `claude` on the PATH: it checks a mod's Claude Code part with `claude plugin validate` (which reads the
// part, never runs it), compares the installed version with the one the part targets, and tells when a change
// reaches Claude Code. It never writes `~/.claude`.

package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentparts"
)

const MoltenClaudeVersionTimeout = 10 * time.Second
const MoltenClaudeValidateTimeout = 60 * time.Second

const (
	MoltenPartTakesEffectNextSession = "next-session"
	MoltenPartTakesEffectNewTerminal = "new-terminal"
)

const moltenClaudeRestartHint = "a running session keeps what it loaded: restart it with /exit, then claude --continue to keep the conversation"

var moltenVersionRegex = regexp.MustCompile(`\b([0-9]+\.[0-9]+\.[0-9]+)\b`)

// Replaced in tests, with moltenRunClaude, so they do not depend on claude being installed.
var moltenClaudeOnPath = func() bool {
	_, err := exec.LookPath("claude")
	return err == nil
}

// Replaced in tests: runs the user's claude and gives its stdout, its exit code and an error when it could not run.
var moltenRunClaude = func(timeout time.Duration, args ...string) ([]byte, int, error) {
	path, err := exec.LookPath("claude")
	if err != nil {
		return nil, 0, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	err = cmd.Run()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return stdout.Bytes(), exitErr.ExitCode(), nil
	}
	if err != nil {
		return nil, 0, err
	}
	return stdout.Bytes(), 0, nil
}

type MoltenPartStatus struct {
	State         string `json:"state"`
	Reason        string `json:"reason,omitempty"`
	Folder        string `json:"folder,omitempty"`
	TargetVersion string `json:"targetversion,omitempty"`
}

// What `molten mod enable|disable|untrust|remove` and `molten undo` say about a mod's Claude Code part.
type MoltenClaudeCodeNote struct {
	State       string `json:"state"`
	TakesEffect string `json:"takeseffect,omitempty"`
	Message     string `json:"message"`
}

func moltenParseClaudeVersion(output string) (string, error) {
	match := moltenVersionRegex.FindStringSubmatch(output)
	if match == nil {
		return "", fmt.Errorf("no version in %q", strings.TrimSpace(output))
	}
	return match[1], nil
}

func moltenClaudeVersion() (string, error) {
	out, code, err := moltenRunClaude(MoltenClaudeVersionTimeout, "--version")
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("claude --version exited with %d", code)
	}
	return moltenParseClaudeVersion(string(out))
}

// The Claude Code plugin API is early access: any difference may matter, and none blocks.
func moltenVersionWarning(target string, installed string) string {
	if target == "" || installed == "" || target == installed {
		return ""
	}
	return fmt.Sprintf("the Claude Code part targets Claude Code %s, installed %s: the plugin API is early access; check the part and update targetVersion", target, installed)
}

type moltenClaudeIssue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

type moltenClaudeFileReport struct {
	File     string              `json:"file"`
	Errors   []moltenClaudeIssue `json:"errors"`
	Warnings []moltenClaudeIssue `json:"warnings"`
}

type moltenClaudeValidateReport struct {
	Success  bool                     `json:"success"`
	Manifest moltenClaudeFileReport   `json:"manifest"`
	Contents []moltenClaudeFileReport `json:"contents"`
}

// Warnings about publishing to a marketplace say nothing about a part that only loads from its folder.
func moltenIgnoredClaudeWarning(issue moltenClaudeIssue) bool {
	return issue.Path == "author" || strings.Contains(issue.Message, "marketplace")
}

// moltenParseClaudeValidate maps the JSON of `claude plugin validate --json <partDir>` to validation problems, with
// files named from the mod folder (`<folder>/<file in the part>`).
func moltenParseClaudeValidate(out []byte, partDir string, folder string) ([]MoltenValidationProblem, error) {
	var report moltenClaudeValidateReport
	if err := json.Unmarshal(out, &report); err != nil {
		return nil, fmt.Errorf("reading the output of claude plugin validate: %w", err)
	}
	realPart, err := filepath.EvalSymlinks(partDir)
	if err != nil {
		realPart = partDir
	}
	fileName := func(file string) string {
		for _, base := range []string{partDir, realPart} {
			if rel, err := filepath.Rel(base, file); err == nil && !strings.HasPrefix(rel, "..") {
				if rel == "." {
					return folder
				}
				return folder + "/" + filepath.ToSlash(rel)
			}
		}
		if realFile, err := filepath.EvalSymlinks(file); err == nil {
			if rel, err := filepath.Rel(realPart, realFile); err == nil && !strings.HasPrefix(rel, "..") && rel != "." {
				return folder + "/" + filepath.ToSlash(rel)
			}
		}
		return folder
	}
	message := func(issue moltenClaudeIssue) string {
		switch issue.Path {
		case "", "json", "directory":
			return "claude plugin validate: " + issue.Message
		}
		return fmt.Sprintf("claude plugin validate: %s: %s", issue.Path, issue.Message)
	}
	problems := []MoltenValidationProblem{}
	for _, file := range append([]moltenClaudeFileReport{report.Manifest}, report.Contents...) {
		for _, issue := range file.Errors {
			problems = append(problems, MoltenValidationProblem{File: fileName(file.File), Message: message(issue)})
		}
		for _, issue := range file.Warnings {
			if moltenIgnoredClaudeWarning(issue) {
				continue
			}
			problems = append(problems, MoltenValidationProblem{File: fileName(file.File), Message: message(issue), Severity: MoltenSeverityWarning})
		}
	}
	return problems, nil
}

func moltenHasErrors(problems []MoltenValidationProblem) bool {
	for _, problem := range problems {
		if problem.Severity != MoltenSeverityWarning {
			return true
		}
	}
	return false
}

// moltenCheckClaudeCodePart adds to a tab's validation result what only the user's claude can tell.
func moltenCheckClaudeCodePart(result *MoltenValidationResult) {
	info, ok := result.Agents[agentparts.AgentClaudeCode]
	if !ok {
		return
	}
	defer func() { result.Ok = !moltenHasErrors(result.Problems) }()
	if !moltenClaudeOnPath() {
		result.Problems = append(result.Problems, MoltenValidationProblem{
			File:     info.Folder,
			Message:  "claude is not on the PATH: the Claude Code part was not checked by claude plugin validate",
			Severity: MoltenSeverityWarning,
		})
		return
	}
	if info.Path != "" {
		if _, err := os.Stat(info.Path); err == nil {
			out, _, err := moltenRunClaude(MoltenClaudeValidateTimeout, "plugin", "validate", "--json", info.Path)
			var problems []MoltenValidationProblem
			if err == nil {
				problems, err = moltenParseClaudeValidate(out, info.Path, info.Folder)
			}
			if err != nil {
				problems = []MoltenValidationProblem{{File: info.Folder, Message: fmt.Sprintf("claude plugin validate did not run: %v", err), Severity: MoltenSeverityWarning}}
			}
			result.Problems = append(result.Problems, problems...)
		}
	}
	installed, err := moltenClaudeVersion()
	if err != nil {
		result.Problems = append(result.Problems, MoltenValidationProblem{File: info.Folder, Message: fmt.Sprintf("the installed Claude Code version is unknown: %v", err), Severity: MoltenSeverityWarning})
		return
	}
	if warning := moltenVersionWarning(info.TargetVersion, installed); warning != "" {
		result.Problems = append(result.Problems, MoltenValidationProblem{File: MoltenManifestFileName, Message: warning, Severity: MoltenSeverityWarning})
	}
}

// moltenPartState is the state of a mod's Claude Code part as wavesrv will apply it; "" when it has none.
func moltenPartState(configDir string, dataDir string, safeMode bool, id string) MoltenPartStatus {
	states, err := agentparts.PartStates(configDir, dataDir, safeMode)
	if err != nil {
		return MoltenPartStatus{}
	}
	for _, state := range states {
		if state.Id == id {
			return MoltenPartStatus{State: state.State, Reason: state.Reason, Folder: state.Folder, TargetVersion: state.TargetVersion}
		}
	}
	return MoltenPartStatus{}
}

// moltenCarriesSlot tells whether this terminal's Claude Code sessions look in the mod's slot, which only terminals
// started once the slot existed do.
func moltenCarriesSlot(dataDir string, id string) bool {
	slot := agentparts.SlotPath(dataDir, id)
	for _, entry := range filepath.SplitList(os.Getenv(agentparts.PluginDirsVarName)) {
		if entry == slot {
			return true
		}
	}
	return false
}

// moltenPartNote says what a change did to a mod's Claude Code part, or nil when it did nothing to it.
func moltenPartNote(id string, before MoltenPartStatus, after MoltenPartStatus, carriesSlot bool, goos string) *MoltenClaudeCodeNote {
	if before.State == after.State || (before.State == "" && after.State == "") {
		return nil
	}
	if goos == "windows" {
		return &MoltenClaudeCodeNote{State: after.State, Message: fmt.Sprintf("mod %q has a Claude Code part, which does not load on Windows in this version", id)}
	}
	switch after.State {
	case agentparts.PartStateActive:
		if !carriesSlot {
			return &MoltenClaudeCodeNote{State: after.State, TakesEffect: MoltenPartTakesEffectNewTerminal,
				Message: fmt.Sprintf("the Claude Code part of %q loads in Claude Code sessions started in a new MoltenTerm terminal: this terminal opened before the part existed", id)}
		}
		return &MoltenClaudeCodeNote{State: after.State, TakesEffect: MoltenPartTakesEffectNextSession,
			Message: fmt.Sprintf("the Claude Code part of %q loads in the next Claude Code session you start in a MoltenTerm terminal; %s", id, moltenClaudeRestartHint)}
	case agentparts.PartStateUntrusted:
		return &MoltenClaudeCodeNote{State: after.State, Message: fmt.Sprintf("the Claude Code part of %q stays off: you did not trust it (molten mod enable %s asks again)", id, id)}
	case agentparts.PartStateInvalid:
		return &MoltenClaudeCodeNote{State: after.State, Message: fmt.Sprintf("the Claude Code part of %q stays off: %s (see molten mod validate %s)", id, after.Reason, id)}
	case agentparts.PartStateSafeMode:
		return &MoltenClaudeCodeNote{State: after.State, Message: fmt.Sprintf("the Claude Code part of %q loads after a normal restart: MoltenTerm runs in safe mode", id)}
	}
	if before.State != agentparts.PartStateActive {
		return nil
	}
	state := after.State
	if state == "" {
		state = "none"
	}
	return &MoltenClaudeCodeNote{State: state, TakesEffect: MoltenPartTakesEffectNextSession,
		Message: fmt.Sprintf("the Claude Code part of %q stops loading at the next Claude Code session; %s", id, moltenClaudeRestartHint)}
}

func moltenClaudeConfigDir() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude")
}

// moltenSettingsOverride warns when Claude Code's user settings set CLAUDE_CODE_PLUGIN_DIRS: that value replaces the
// one MoltenTerm gives the terminal, so no part would load. The file is only read.
func moltenSettingsOverride(configDir string) string {
	if configDir == "" {
		return ""
	}
	path := filepath.Join(configDir, "settings.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var settings struct {
		Env map[string]any `json:"env"`
	}
	if json.Unmarshal(data, &settings) != nil {
		return ""
	}
	if _, ok := settings.Env[agentparts.PluginDirsVarName]; !ok {
		return ""
	}
	return fmt.Sprintf("%s sets env.%s, which replaces the folders MoltenTerm gives Claude Code: no Claude Code part of a mod loads; move your folders to the variable in your shell instead", path, agentparts.PluginDirsVarName)
}

// moltenShellOverride warns when slots exist but this terminal carries none: it opened before any part existed, or a
// shell startup file replaces the variable instead of appending to it.
func moltenShellOverride(dataDir string, safeMode bool, goos string) string {
	if safeMode || goos == "windows" || len(agentparts.Slots(dataDir)) == 0 {
		return ""
	}
	for _, entry := range filepath.SplitList(os.Getenv(agentparts.PluginDirsVarName)) {
		if agentparts.IsSlotEntry(entry) {
			return ""
		}
	}
	return fmt.Sprintf("this terminal's %s names no MoltenTerm Claude Code part: open a new MoltenTerm terminal; if that one has none either, a shell startup file replaces the variable: append to it instead (export %s=\"$%s:/your/folder\")",
		agentparts.PluginDirsVarName, agentparts.PluginDirsVarName, agentparts.PluginDirsVarName)
}

// moltenPartWarnings gathers what keeps parts from loading in this terminal, once a part is meant to load.
func moltenPartWarnings(dataDir string, safeMode bool) []string {
	var warnings []string
	if w := moltenSettingsOverride(moltenClaudeConfigDir()); w != "" {
		warnings = append(warnings, w)
	}
	if w := moltenShellOverride(dataDir, safeMode, runtime.GOOS); w != "" {
		warnings = append(warnings, w)
	}
	return warnings
}

// moltenPartContext reads what the notes need: the directories and whether the app runs in safe mode.
type moltenPartContext struct {
	configDir string
	dataDir   string
	safeMode  bool
}

func moltenGetPartContext() (moltenPartContext, error) {
	configDir, err := moltenGetPath("config")
	if err != nil {
		return moltenPartContext{}, err
	}
	dataDir, err := moltenGetPath("data")
	if err != nil {
		return moltenPartContext{}, err
	}
	ctx := moltenPartContext{configDir: configDir, dataDir: dataDir}
	if list, err := moltenGetModList(); err == nil {
		ctx.safeMode = list.SafeMode
	}
	return ctx, nil
}

func (c moltenPartContext) state(id string) MoltenPartStatus {
	return moltenPartState(c.configDir, c.dataDir, c.safeMode, id)
}

// note prints the note of a change unless --json, and gives it for the JSON answer.
func (c moltenPartContext) note(id string, before MoltenPartStatus) *MoltenClaudeCodeNote {
	after := c.state(id)
	note := moltenPartNote(id, before, after, moltenCarriesSlot(c.dataDir, id), runtime.GOOS)
	if note == nil || moltenJson {
		return note
	}
	WriteStdout("%s\n", note.Message)
	if note.State == agentparts.PartStateActive {
		for _, warning := range moltenPartWarnings(c.dataDir, c.safeMode) {
			WriteStderr("molten: warning: %s\n", warning)
		}
	}
	return note
}
