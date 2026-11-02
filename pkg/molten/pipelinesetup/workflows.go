// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// The GitHub workflows a release setup reads (DS-MC-031): what starts each one (a pushed tag, a branch, a dispatch),
// the environments its jobs deploy to, and what it does (CI, publish, deploy, docs).

const (
	WorkflowsDir = ".github/workflows"

	RoleCi      = "ci"
	RolePublish = "publish"
	RoleDeploy  = "deploy"
	RoleDocs    = "docs"
	RoleOther   = "other"

	maxWorkflowBytes = 512 << 10
)

type Workflow struct {
	File string `json:"file"`
	Name string `json:"name,omitempty"`
	// The push filters; Tags/Branches nil: no such filter, Push false: no push trigger.
	Push           bool     `json:"push"`
	Tags           []string `json:"tags,omitempty"`
	TagsIgnore     []string `json:"tagsignore,omitempty"`
	Branches       []string `json:"branches,omitempty"`
	BranchesIgnore []string `json:"branchesignore,omitempty"`
	PullRequest    bool     `json:"pullrequest,omitempty"`
	Dispatch       bool     `json:"dispatch"`
	Inputs         []string `json:"inputs,omitempty"`
	// Inputs a dispatch must give.
	RequiredInputs []string `json:"requiredinputs,omitempty"`
	Environments   []string `json:"environments,omitempty"`
	Role           string   `json:"role"`
	// What it builds or ships (packager target ids, see rules.go).
	Ships []string `json:"ships,omitempty"`
}

var (
	npmPublishRegex   = regexp.MustCompile(`\bnpm publish\b|\bpnpm publish\b|\byarn npm publish\b`)
	ghReleaseRegex    = regexp.MustCompile(`\bgh release (create|upload)\b|softprops/action-gh-release|ncipollo/release-action`)
	containerRegex    = regexp.MustCompile(`docker/build-push-action|\bdocker push\b`)
	pagesRegex        = regexp.MustCompile(`actions/deploy-pages|peaceiris/actions-gh-pages`)
	desktopBuildRegex = regexp.MustCompile(`tauri-apps/tauri-action|electron-builder|\btauri build\b`)
	deployWordRegex   = regexp.MustCompile(`(?i)deploy`)
	docsWordRegex     = regexp.MustCompile(`(?i)\b(docs?|documentation|pages|site|website)\b`)
)

// ReadWorkflows reads every workflow of the repository; an unreadable one is skipped.
func ReadWorkflows(dir string) []Workflow {
	entries, err := os.ReadDir(filepath.Join(dir, filepath.FromSlash(WorkflowsDir)))
	if err != nil {
		return nil
	}
	var rtn []Workflow
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !(strings.HasSuffix(name, ".yml") || strings.HasSuffix(name, ".yaml")) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(WorkflowsDir), name))
		if err != nil || len(data) > maxWorkflowBytes {
			continue
		}
		if wf, ok := ParseWorkflow(name, data); ok {
			rtn = append(rtn, wf)
		}
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].File < rtn[j].File })
	return rtn
}

func mapValue(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			return node.Content[i+1]
		}
	}
	return nil
}

func scalars(node *yaml.Node) []string {
	if node == nil {
		return nil
	}
	switch node.Kind {
	case yaml.ScalarNode:
		return []string{node.Value}
	case yaml.SequenceNode:
		var rtn []string
		for _, item := range node.Content {
			if item.Kind == yaml.ScalarNode {
				rtn = append(rtn, item.Value)
			}
		}
		return rtn
	}
	return nil
}

func mapKeys(node *yaml.Node) []string {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	var rtn []string
	for i := 0; i+1 < len(node.Content); i += 2 {
		rtn = append(rtn, node.Content[i].Value)
	}
	return rtn
}

// ParseWorkflow reads one workflow file; false when it is not a workflow.
func ParseWorkflow(file string, data []byte) (Workflow, bool) {
	var doc yaml.Node
	if yaml.Unmarshal(data, &doc) != nil || len(doc.Content) == 0 {
		return Workflow{}, false
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return Workflow{}, false
	}
	wf := Workflow{File: file}
	if name := mapValue(root, "name"); name != nil {
		wf.Name = name.Value
	}
	on := mapValue(root, "on")
	if on == nil {
		// YAML 1.1 readers turn the key `on` into true.
		on = mapValue(root, "true")
	}
	readTriggers(&wf, on)
	jobs := mapValue(root, "jobs")
	text := string(data)
	for _, jobName := range mapKeys(jobs) {
		job := mapValue(jobs, jobName)
		env := mapValue(job, "environment")
		if env != nil && env.Kind == yaml.MappingNode {
			env = mapValue(env, "name")
		}
		if env != nil && env.Kind == yaml.ScalarNode && env.Value != "" && !strings.Contains(env.Value, "${{") {
			wf.Environments = appendOnce(wf.Environments, env.Value)
		}
	}
	wf.Ships = shipsOf(text)
	wf.Role = roleOf(wf, text)
	return wf, true
}

func readTriggers(wf *Workflow, on *yaml.Node) {
	if on == nil {
		return
	}
	events := map[string]*yaml.Node{}
	switch on.Kind {
	case yaml.ScalarNode, yaml.SequenceNode:
		for _, event := range scalars(on) {
			events[event] = nil
		}
	case yaml.MappingNode:
		for i := 0; i+1 < len(on.Content); i += 2 {
			events[on.Content[i].Value] = on.Content[i+1]
		}
	}
	if push, ok := events["push"]; ok {
		wf.Push = true
		wf.Tags = scalars(mapValue(push, "tags"))
		wf.TagsIgnore = scalars(mapValue(push, "tags-ignore"))
		wf.Branches = scalars(mapValue(push, "branches"))
		wf.BranchesIgnore = scalars(mapValue(push, "branches-ignore"))
	}
	_, pr := events["pull_request"]
	_, prt := events["pull_request_target"]
	_, mg := events["merge_group"]
	wf.PullRequest = pr || prt || mg
	if dispatch, ok := events["workflow_dispatch"]; ok {
		wf.Dispatch = true
		inputs := mapValue(dispatch, "inputs")
		for _, input := range mapKeys(inputs) {
			wf.Inputs = append(wf.Inputs, input)
			if required := mapValue(mapValue(inputs, input), "required"); required != nil && required.Value == "true" {
				wf.RequiredInputs = append(wf.RequiredInputs, input)
			}
		}
	}
}

func appendOnce(list []string, value string) []string {
	for _, v := range list {
		if v == value {
			return list
		}
	}
	return append(list, value)
}

func shipsOf(text string) []string {
	var rtn []string
	if npmPublishRegex.MatchString(text) {
		rtn = append(rtn, TargetNpm)
	}
	if containerRegex.MatchString(text) {
		rtn = append(rtn, TargetContainer)
	}
	if ghReleaseRegex.MatchString(text) || desktopBuildRegex.MatchString(text) {
		rtn = append(rtn, TargetGithubRelease)
	}
	if pagesRegex.MatchString(text) {
		rtn = append(rtn, TargetPages)
	}
	return rtn
}

func roleOf(wf Workflow, text string) string {
	label := wf.File + " " + wf.Name
	onTags := wf.Push && (len(wf.Tags) > 0 || (wf.Branches == nil && wf.BranchesIgnore == nil))
	if pagesRegex.MatchString(text) || (deployWordRegex.MatchString(label) && docsWordRegex.MatchString(label)) {
		return RoleDocs
	}
	if onTags && (npmPublishRegex.MatchString(text) || ghReleaseRegex.MatchString(text) || desktopBuildRegex.MatchString(text)) {
		return RolePublish
	}
	if deployWordRegex.MatchString(label) || (len(wf.Environments) > 0 && !onTags) {
		return RoleDeploy
	}
	if wf.PullRequest || len(wf.Branches) > 0 {
		return RoleCi
	}
	return RoleOther
}

// githubFilterRegex turns a GitHub Actions filter pattern into a regular expression: `*` any run of characters but
// `/`, `**` any run, `?` and `+` zero-or-one and one-or-more of the character before, `[...]` a class, `\` escapes.
func githubFilterRegex(pattern string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		switch {
		case c == '*' && i+1 < len(pattern) && pattern[i+1] == '*':
			b.WriteString(".*")
			i++
		case c == '*':
			b.WriteString("[^/]*")
		case c == '?' || c == '+':
			b.WriteByte(c)
		case c == '[':
			end := strings.IndexByte(pattern[i:], ']')
			if end < 0 {
				b.WriteString(regexp.QuoteMeta(pattern[i:]))
				i = len(pattern)
				continue
			}
			b.WriteString(pattern[i : i+end+1])
			i += end
		case c == '\\' && i+1 < len(pattern):
			b.WriteString(regexp.QuoteMeta(string(pattern[i+1])))
			i++
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}

// FilterMatches applies GitHub's rule: the last pattern that matches decides, a `!` pattern excluding.
func FilterMatches(patterns []string, name string) bool {
	matched := false
	for _, pattern := range patterns {
		negated := strings.HasPrefix(pattern, "!")
		re, err := githubFilterRegex(strings.TrimPrefix(pattern, "!"))
		if err != nil || !re.MatchString(name) {
			continue
		}
		matched = !negated
	}
	return matched
}

// RunsOnTag tells whether pushing the tag starts the workflow.
func (wf Workflow) RunsOnTag(tag string) bool {
	if !wf.Push {
		return false
	}
	if wf.Tags == nil && wf.TagsIgnore == nil {
		// Only branch filters: a pushed tag starts nothing. No filter at all: every push does.
		return wf.Branches == nil && wf.BranchesIgnore == nil
	}
	if wf.Tags != nil {
		return FilterMatches(wf.Tags, tag)
	}
	return !FilterMatches(wf.TagsIgnore, tag)
}

// RunsOnBranch tells whether pushing the branch starts the workflow.
func (wf Workflow) RunsOnBranch(branch string) bool {
	if !wf.Push {
		return false
	}
	if wf.Branches == nil && wf.BranchesIgnore == nil {
		return wf.Tags == nil && wf.TagsIgnore == nil
	}
	if wf.Branches != nil {
		return FilterMatches(wf.Branches, branch)
	}
	return !FilterMatches(wf.BranchesIgnore, branch)
}
