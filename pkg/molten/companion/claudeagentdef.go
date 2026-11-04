// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// A Claude Code sub-agent's model and effort are known from its transcript once the model has answered; until then
// the agent definition it runs (<folder>/.claude/agents/<type>.md, else the user's <config>/agents/<type>.md) says
// them in its frontmatter (#1848). Read only and bounded: the first lines of one small file, nothing else of it.

const (
	claudeAgentDefMaxBytes = 16 * 1024
	claudeAgentDefMaxLines = 60
)

// An agent type names a file: letters, digits, dots, dashes and underscores only.
var claudeAgentTypeRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

// claudeAgentDefinition reads the model and effort of the definition of an agent type, looked up in the sub-agent's
// folder, then in the user's agents folder next to each projects root. "" for a fact the definition does not give,
// and for a model it leaves to the parent ("inherit").
func (a *ClaudeAdapter) claudeAgentDefinition(agentType string, folder string) (model string, effort string) {
	if !claudeAgentTypeRegex.MatchString(agentType) {
		return "", ""
	}
	var dirs []string
	if filepath.IsAbs(folder) {
		dirs = append(dirs, filepath.Join(filepath.Clean(folder), ".claude", "agents"))
	}
	for _, root := range a.roots {
		dirs = append(dirs, filepath.Join(filepath.Dir(root), "agents"))
	}
	for _, dir := range dirs {
		if model, effort, ok := readClaudeAgentFrontmatter(filepath.Join(dir, agentType+".md")); ok {
			return model, effort
		}
	}
	return "", ""
}

// readClaudeAgentFrontmatter reads the model and effort keys of a definition's frontmatter; false when the file is not
// a regular file or has no frontmatter.
func readClaudeAgentFrontmatter(path string) (model string, effort string, ok bool) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", "", false
	}
	f, err := os.Open(path)
	if err != nil {
		return "", "", false
	}
	defer f.Close()
	reader := bufio.NewReader(io.LimitReader(f, claudeAgentDefMaxBytes))
	first, err := reader.ReadString('\n')
	if err != nil || strings.TrimSpace(first) != "---" {
		return "", "", false
	}
	for i := 0; i < claudeAgentDefMaxLines; i++ {
		line, err := reader.ReadString('\n')
		text := strings.TrimSpace(line)
		if text == "---" {
			return model, effort, true
		}
		key, value, found := strings.Cut(text, ":")
		if found {
			value = strings.Trim(strings.TrimSpace(value), `"'`)
			switch strings.ToLower(strings.TrimSpace(key)) {
			case "model":
				if !strings.EqualFold(value, "inherit") {
					model = codexSettingText(value)
				}
			case "effort":
				effort = codexSettingText(value)
			}
		}
		if err != nil {
			return "", "", false
		}
	}
	return "", "", false
}

// withAgentDefinition fills the model and effort a transcript did not give from the agent definition of the
// sub-agent's type; what the transcript says stays.
func (a *ClaudeAdapter) withAgentDefinition(model string, effort string, agentType string, folder string) (string, string) {
	if model != "" && effort != "" {
		return model, effort
	}
	defModel, defEffort := a.claudeAgentDefinition(agentType, folder)
	if model == "" {
		model = defModel
	}
	if effort == "" {
		effort = defEffort
	}
	return model, effort
}
