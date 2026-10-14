// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"gopkg.in/yaml.v3"
)

// The CI/CD panel's Jobs tab (#637): every job of the project's GitHub Actions workflows and of its local CI, with
// what it is for and when it runs. Read from the files on disk only, never from GitHub, and never written: a job
// without a description is described by the user's agent, as a change the developer reviews.

const (
	JobsCommand        = "moltenmissionjobs"
	JobDescribeCommand = "moltenmissionjobdescribe"

	JobKindWorkflow = "workflow"
	JobKindLocal    = "local"

	workflowsDir = ".github/workflows"
	// The local CI's jobs without a lane run in this one (frontend jobsByLane).
	defaultCiLane = "main"
)

var copyrightLineRegex = regexp.MustCompile(`(?i)^(copyright\b|spdx-license-identifier:)`)

// WorkflowTrigger is one event a workflow runs on, with its filters as the file gives them.
type WorkflowTrigger struct {
	Event          string   `json:"event"`
	Branches       []string `json:"branches,omitempty"`
	BranchesIgnore []string `json:"branchesignore,omitempty"`
	Tags           []string `json:"tags,omitempty"`
	TagsIgnore     []string `json:"tagsignore,omitempty"`
	Paths          []string `json:"paths,omitempty"`
	PathsIgnore    []string `json:"pathsignore,omitempty"`
	Types          []string `json:"types,omitempty"`
	Crons          []string `json:"crons,omitempty"`
	// The inputs a run started by hand (workflow_dispatch) or by another workflow (workflow_call) asks for.
	Inputs []string `json:"inputs,omitempty"`
	// workflow_run: the workflows whose runs start this one.
	Workflows []string `json:"workflows,omitempty"`
}

type CatalogueJob struct {
	Id   string `json:"id"`
	Name string `json:"name,omitempty"`
	// 1-based line of the job's key in its file.
	Line        int      `json:"line"`
	Description string   `json:"description,omitempty"`
	If          string   `json:"if,omitempty"`
	Needs       []string `json:"needs,omitempty"`
	// A job that calls a reusable workflow.
	Uses string `json:"uses,omitempty"`
}

type CatalogueWorkflow struct {
	File string `json:"file"`
	Path string `json:"path"`
	Name string `json:"name,omitempty"`
	// The file's header comment, copyright lines left out.
	Description string            `json:"description,omitempty"`
	Triggers    []WorkflowTrigger `json:"triggers"`
	Jobs        []CatalogueJob    `json:"jobs"`
	Error       string            `json:"error,omitempty"`
}

type CatalogueLocalJob struct {
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Lane        string `json:"lane"`
	Order       int    `json:"order"`
	Line        int    `json:"line,omitempty"`
	Description string `json:"description,omitempty"`
	Run         string `json:"run,omitempty"`
}

type CatalogueLocal struct {
	Path string              `json:"path"`
	Jobs []CatalogueLocalJob `json:"jobs"`
	// Statuses: "github" when each verdict is published as the commit status local-<job>.
	Statuses string `json:"statuses,omitempty"`
	// The builds whose command waits for a green local CI first.
	VerifyBuilds []string `json:"verifybuilds,omitempty"`
}

type CiCatalogue struct {
	Dir       string              `json:"dir"`
	Workflows []CatalogueWorkflow `json:"workflows"`
	Local     *CatalogueLocal     `json:"local,omitempty"`
}

type JobsRequest struct {
	Dir string `json:"dir"`
}

type JobDescribeRequest struct {
	Dir     string `json:"dir"`
	BlockId string `json:"blockid"`
	Kind    string `json:"kind"`
	File    string `json:"file,omitempty"`
	Job     string `json:"job"`
}

type JobDescribeResult struct {
	Sent      bool   `json:"sent"`
	Submitted bool   `json:"submitted,omitempty"`
	Message   string `json:"message"`
}

// AgentLine types a line into the prompt of the agent running in a terminal through the guarded agent input
// (pkg/molten/termupdate), which imports this package: wavesrv's block controller registers it.
type AgentLine func(ctx context.Context, blockId string, line string) JobDescribeResult

var agentLineLock sync.Mutex
var agentLine AgentLine

func UseAgentLine(fn AgentLine) {
	agentLineLock.Lock()
	defer agentLineLock.Unlock()
	agentLine = fn
}

func getAgentLine() AgentLine {
	agentLineLock.Lock()
	defer agentLineLock.Unlock()
	return agentLine
}

func isWorkflowFile(name string) bool {
	return strings.HasSuffix(name, ".yml") || strings.HasSuffix(name, ".yaml")
}

// WorkflowsStamp tells when the workflow files changed, from their names, sizes and times alone: the snapshot every
// panel already asks for carries it, and the Jobs tab reads the files again only when it moves.
func WorkflowsStamp(dir string) string {
	entries, err := os.ReadDir(filepath.Join(dir, workflowsDir))
	if err != nil {
		return ""
	}
	var parts []string
	for _, entry := range entries {
		if entry.IsDir() || !isWorkflowFile(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s:%d:%d", entry.Name(), info.Size(), info.ModTime().UnixNano()))
	}
	return strings.Join(parts, "|")
}

// ReadCiCatalogue reads the project's workflows and local CI jobs. A file that cannot be read keeps its row, with
// the reason.
func ReadCiCatalogue(dir string) (*CiCatalogue, error) {
	if err := checkDir(dir); err != nil {
		return nil, err
	}
	dir = filepath.Clean(dir)
	cat := &CiCatalogue{Dir: dir, Workflows: []CatalogueWorkflow{}}
	entries, _ := os.ReadDir(filepath.Join(dir, workflowsDir))
	for _, entry := range entries {
		if entry.IsDir() || !isWorkflowFile(entry.Name()) {
			continue
		}
		path := filepath.Join(dir, workflowsDir, entry.Name())
		data, err := os.ReadFile(path)
		if err == nil && len(data) > maxWorkflowFileBytes {
			err = errors.New("the file is too large to read")
		}
		if err != nil {
			cat.Workflows = append(cat.Workflows, CatalogueWorkflow{File: entry.Name(), Path: path, Triggers: []WorkflowTrigger{}, Jobs: []CatalogueJob{}, Error: err.Error()})
			continue
		}
		wf := ParseWorkflow(entry.Name(), string(data))
		wf.Path = path
		cat.Workflows = append(cat.Workflows, wf)
	}
	sort.Slice(cat.Workflows, func(i, j int) bool { return cat.Workflows[i].File < cat.Workflows[j].File })
	report := molten.ValidatePipeline(dir)
	if report.Pipeline != nil && report.Pipeline.Ci != nil {
		text, _ := os.ReadFile(report.Path)
		cat.Local = localCatalogue(report.Path, string(text), report.Pipeline)
	}
	return cat, nil
}

func localCatalogue(path string, text string, pipeline *molten.Pipeline) *CatalogueLocal {
	local := &CatalogueLocal{Path: path, Jobs: []CatalogueLocalJob{}, Statuses: pipeline.Ci.Statuses}
	lines := strings.Split(text, "\n")
	order := map[string]int{}
	for _, job := range pipeline.Ci.Jobs {
		lane := job.Lane
		if lane == "" {
			lane = defaultCiLane
		}
		order[lane]++
		local.Jobs = append(local.Jobs, CatalogueLocalJob{
			Name:        job.Name,
			Title:       job.Title,
			Lane:        lane,
			Order:       order[lane],
			Line:        jsonNameLine(lines, job.Name),
			Description: strings.TrimSpace(job.Description),
			Run:         job.Run,
		})
	}
	for _, build := range pipeline.Builds {
		if build.Verify != molten.PipelineBuildVerifyCi {
			continue
		}
		title := build.Title
		if title == "" {
			title = build.Id
		}
		local.VerifyBuilds = append(local.VerifyBuilds, title)
	}
	return local
}

// jsonNameLine finds the line declaring `"name": "<name>"` after the ci section starts; 0 when not found.
func jsonNameLine(lines []string, name string) int {
	quoted := regexp.QuoteMeta(strconv.Quote(name))
	re := regexp.MustCompile(`"name"\s*:\s*` + quoted)
	start := 0
	for i, line := range lines {
		if strings.Contains(line, `"ci"`) {
			start = i
			break
		}
	}
	for i := start; i < len(lines); i++ {
		if re.MatchString(lines[i]) {
			return i + 1
		}
	}
	return 0
}

func mappingValue(node *yaml.Node, key string) *yaml.Node {
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

// stringList reads a scalar or a sequence of scalars.
func stringList(node *yaml.Node) []string {
	if node == nil {
		return nil
	}
	switch node.Kind {
	case yaml.ScalarNode:
		if node.Value == "" || node.Tag == "!!null" {
			return nil
		}
		return []string{node.Value}
	case yaml.SequenceNode:
		var rtn []string
		for _, item := range node.Content {
			if item.Kind == yaml.ScalarNode && item.Value != "" {
				rtn = append(rtn, item.Value)
			}
		}
		return rtn
	}
	return nil
}

func mappingKeys(node *yaml.Node) []string {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	var rtn []string
	for i := 0; i+1 < len(node.Content); i += 2 {
		rtn = append(rtn, node.Content[i].Value)
	}
	return rtn
}

func parseTrigger(event string, body *yaml.Node) WorkflowTrigger {
	trigger := WorkflowTrigger{Event: event}
	if event == "schedule" && body != nil && body.Kind == yaml.SequenceNode {
		for _, item := range body.Content {
			if cron := mappingValue(item, "cron"); cron != nil && cron.Value != "" {
				trigger.Crons = append(trigger.Crons, cron.Value)
			}
		}
		return trigger
	}
	if body == nil || body.Kind != yaml.MappingNode {
		return trigger
	}
	trigger.Branches = stringList(mappingValue(body, "branches"))
	trigger.BranchesIgnore = stringList(mappingValue(body, "branches-ignore"))
	trigger.Tags = stringList(mappingValue(body, "tags"))
	trigger.TagsIgnore = stringList(mappingValue(body, "tags-ignore"))
	trigger.Paths = stringList(mappingValue(body, "paths"))
	trigger.PathsIgnore = stringList(mappingValue(body, "paths-ignore"))
	trigger.Types = stringList(mappingValue(body, "types"))
	trigger.Inputs = mappingKeys(mappingValue(body, "inputs"))
	trigger.Workflows = stringList(mappingValue(body, "workflows"))
	return trigger
}

func parseTriggers(on *yaml.Node) []WorkflowTrigger {
	triggers := []WorkflowTrigger{}
	if on == nil {
		return triggers
	}
	switch on.Kind {
	case yaml.ScalarNode, yaml.SequenceNode:
		for _, event := range stringList(on) {
			triggers = append(triggers, WorkflowTrigger{Event: event})
		}
	case yaml.MappingNode:
		for i := 0; i+1 < len(on.Content); i += 2 {
			triggers = append(triggers, parseTrigger(on.Content[i].Value, on.Content[i+1]))
		}
	}
	return triggers
}

// commentText reads a block of `#` lines as text: lines of a paragraph join with a space, an empty `#` line starts a
// paragraph, and an indented line (a list, a table) keeps its own line.
func commentText(lines []string) string {
	var paragraphs [][]string
	var current []string
	flush := func() {
		if len(current) > 0 {
			paragraphs = append(paragraphs, current)
		}
		current = nil
	}
	for _, line := range lines {
		body := strings.TrimPrefix(strings.TrimSpace(line), "#")
		if strings.TrimSpace(body) == "" {
			flush()
			continue
		}
		current = append(current, body)
	}
	flush()
	var out []string
	for _, para := range paragraphs {
		copyright := true
		for _, line := range para {
			if !copyrightLineRegex.MatchString(strings.TrimSpace(line)) {
				copyright = false
				break
			}
		}
		if copyright {
			continue
		}
		var text strings.Builder
		for i, line := range para {
			indented := strings.HasPrefix(line, "  ")
			trimmed := strings.TrimSpace(line)
			if i > 0 {
				if indented {
					text.WriteString("\n")
				} else {
					text.WriteString(" ")
				}
			}
			text.WriteString(trimmed)
		}
		out = append(out, text.String())
	}
	return strings.Join(out, "\n\n")
}

func isCommentLine(line string) bool {
	return strings.HasPrefix(strings.TrimSpace(line), "#")
}

// headerComment is the comment block the file starts with, before its first key.
func headerComment(lines []string) string {
	var block []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			block = append(block, "#")
			continue
		}
		if !isCommentLine(line) {
			break
		}
		block = append(block, line)
	}
	return commentText(block)
}

func indentOf(line string) int {
	return len(line) - len(strings.TrimLeft(line, " \t"))
}

// jobComment is the comment block right above the job's key, else the one right under it before its first key. A
// comment above must sit at the key's indentation: deeper, it ends the previous job's last step.
func jobComment(lines []string, keyLine int) string {
	idx := keyLine - 1
	if idx < 0 || idx >= len(lines) {
		return ""
	}
	indent := indentOf(lines[idx])
	var above []string
	for i := idx - 1; i >= 0 && isCommentLine(lines[i]) && indentOf(lines[i]) == indent; i-- {
		above = append([]string{lines[i]}, above...)
	}
	if text := commentText(above); text != "" {
		return text
	}
	var under []string
	for i := idx + 1; i < len(lines) && isCommentLine(lines[i]) && indentOf(lines[i]) > indent; i++ {
		under = append(under, lines[i])
	}
	return commentText(under)
}

// ParseWorkflow reads one workflow file. Descriptions are the file's own comments, never made up.
func ParseWorkflow(file string, text string) CatalogueWorkflow {
	wf := CatalogueWorkflow{File: file, Triggers: []WorkflowTrigger{}, Jobs: []CatalogueJob{}}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	wf.Description = headerComment(lines)
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		wf.Error = "unreadable YAML: " + err.Error()
		return wf
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		wf.Error = "not a workflow: the file holds no mapping"
		return wf
	}
	root := doc.Content[0]
	if name := mappingValue(root, "name"); name != nil {
		wf.Name = name.Value
	}
	wf.Triggers = parseTriggers(mappingValue(root, "on"))
	jobs := mappingValue(root, "jobs")
	if jobs == nil || jobs.Kind != yaml.MappingNode {
		return wf
	}
	for i := 0; i+1 < len(jobs.Content); i += 2 {
		key, body := jobs.Content[i], jobs.Content[i+1]
		job := CatalogueJob{Id: key.Value, Line: key.Line, Description: jobComment(lines, key.Line)}
		if name := mappingValue(body, "name"); name != nil {
			job.Name = name.Value
		}
		if cond := mappingValue(body, "if"); cond != nil && cond.Kind == yaml.ScalarNode {
			job.If = strings.TrimSpace(cond.Value)
		}
		job.Needs = stringList(mappingValue(body, "needs"))
		if uses := mappingValue(body, "uses"); uses != nil {
			job.Uses = uses.Value
		}
		wf.Jobs = append(wf.Jobs, job)
	}
	return wf
}

// describeLine is the request typed into the agent: built here from the files, never from a window's text.
func describeLine(cat *CiCatalogue, req JobDescribeRequest) (string, error) {
	switch req.Kind {
	case JobKindWorkflow:
		for _, wf := range cat.Workflows {
			if wf.File != req.File {
				continue
			}
			for _, job := range wf.Jobs {
				if job.Id == req.Job {
					return fmt.Sprintf("Please add a short comment right above the job %q in %s/%s (line %d) saying in one or two sentences what the job is for and why it runs when it does. Change nothing else in the file.", job.Id, workflowsDir, wf.File, job.Line), nil
				}
			}
		}
	case JobKindLocal:
		if cat.Local != nil {
			for _, job := range cat.Local.Jobs {
				if job.Name == req.Job {
					return fmt.Sprintf("Please add a \"description\" to the local CI job %q in %s (line %d): one sentence saying what the job checks. Change nothing else in the file.", job.Name, molten.ProjectPipelineFile, job.Line), nil
				}
			}
		}
	}
	return "", fmt.Errorf("the job %q is no longer in the project's CI files", req.Job)
}

// DescribeJob asks the agent of a terminal to describe a job in its file.
func DescribeJob(ctx context.Context, req JobDescribeRequest) (JobDescribeResult, error) {
	if req.BlockId == "" {
		return JobDescribeResult{}, errors.New("no agent was chosen")
	}
	cat, err := ReadCiCatalogue(req.Dir)
	if err != nil {
		return JobDescribeResult{}, err
	}
	line, err := describeLine(cat, req)
	if err != nil {
		return JobDescribeResult{}, err
	}
	typeLine := getAgentLine()
	if typeLine == nil {
		return JobDescribeResult{Message: "MoltenTerm cannot type in terminals yet: nothing was sent."}, nil
	}
	return typeLine(ctx, req.BlockId, line), nil
}
