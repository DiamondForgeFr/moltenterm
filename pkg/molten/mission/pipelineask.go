// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
)

// "Ask for help" in the pipeline setup's tab (FR-MC-038, #1150): the screen's context goes to the agent of the tab's
// terminal, MoltenTerm's own request way (#1143): a brief in MoltenTerm's data folder and a short prompt typed when the
// agent's prompt is idle, whatever its CLI. The window starts the agent first when none runs there (the developer's
// click), then asks again with Wait: the request waits for the agent to show up. The agent's brief is the pipeline
// writing guide (pipeline-writing-guide.md, #1152), written beside the setup's answers and named in the request.

const (
	PipelineAskCommand = "moltenmissionpipelineask"
	// PipelineWritingGuideFile: how the AI speaks in the pipeline setup; embedded by agentdocs once #1152 ships it.
	PipelineWritingGuideFile = "pipeline-writing-guide.md"

	PipelineAskSent    = "sent"
	PipelineAskNoAgent = "noagent"

	pipelineAskWait     = 45 * time.Second
	pipelineAskPoll     = 500 * time.Millisecond
	maxPipelineAskChars = 8000
)

type PipelineAskRequest struct {
	BlockId string `json:"blockid"`
	Dir     string `json:"dir"`
	Project string `json:"project,omitempty"`
	// Context: what the screen says, in plain text (the step, the question, what was said).
	Context string `json:"context,omitempty"`
	// Wait: the agent was just started; wait for it to run before asking.
	Wait bool `json:"wait,omitempty"`
}

type PipelineAskResult struct {
	// Status: sent, or noagent when no agent runs in the terminal (the window starts one).
	Status string `json:"status"`
	// Delivery: the handoff's delivered, typed or queued.
	Delivery string `json:"delivery,omitempty"`
	To       string `json:"to,omitempty"`
}

type pipelineAskEnv struct {
	running func(blockId string) bool
	send    func(ctx context.Context, req agenthandoff.AppRequest) (agenthandoff.AppSent, error)
	guide   func() string
	poll    time.Duration
}

func defaultPipelineAskEnv(briefDir string) pipelineAskEnv {
	return pipelineAskEnv{
		running: func(blockId string) bool {
			run, ok := attention.AgentRun(blockId)
			return ok && run.Running
		},
		send:  agenthandoff.SendFromApp,
		guide: func() string { return writePipelineGuide(briefDir) },
		poll:  pipelineAskPoll,
	}
}

// writePipelineGuide writes the embedded guide where the agent can read it and returns its path, "" when this build
// has no guide yet.
func writePipelineGuide(dir string) string {
	data, err := fs.ReadFile(agentdocs.Files, PipelineWritingGuideFile)
	if err != nil || dir == "" {
		return ""
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	path := filepath.Join(dir, PipelineWritingGuideFile)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return ""
	}
	return path
}

// pipelineAskGoal is the request's goal: help the developer with the setup, in the guide's words when there is one.
func pipelineAskGoal(project string, guidePath string) string {
	goal := fmt.Sprintf("The developer asks for help with the release pipeline setup of %s, in MoltenTerm's pipeline setup tab. "+
		"Answer their question in plain words, as someone who knows releases well; change no file unless they ask.", project)
	if guidePath != "" {
		goal += fmt.Sprintf(" First read %s: it is how to speak about the pipeline and what you may ask.", guidePath)
	}
	return goal
}

func checkPipelineAsk(req PipelineAskRequest) error {
	if req.BlockId == "" {
		return errors.New("no terminal given")
	}
	if req.Dir == "" || !filepath.IsAbs(req.Dir) {
		return errors.New("the project folder must be an absolute path")
	}
	if len(req.Context) > maxPipelineAskChars {
		return errors.New("the context is too long")
	}
	return nil
}

func askPipelineAgent(ctx context.Context, env pipelineAskEnv, req PipelineAskRequest) (PipelineAskResult, error) {
	if err := checkPipelineAsk(req); err != nil {
		return PipelineAskResult{}, err
	}
	if !env.running(req.BlockId) {
		if !req.Wait {
			return PipelineAskResult{Status: PipelineAskNoAgent}, nil
		}
		if !waitPipelineAgent(ctx, env, req.BlockId) {
			return PipelineAskResult{}, errors.New("the agent did not start in the terminal")
		}
	}
	project := strings.TrimSpace(req.Project)
	if project == "" {
		project = filepath.Base(filepath.Clean(req.Dir))
	}
	sent, err := env.send(ctx, agenthandoff.AppRequest{
		ToBlockId: req.BlockId,
		Goal:      pipelineAskGoal(project, env.guide()),
		Context:   strings.TrimSpace(req.Context),
	})
	if err != nil {
		return PipelineAskResult{}, err
	}
	return PipelineAskResult{Status: PipelineAskSent, Delivery: sent.Status, To: sent.To}, nil
}

func waitPipelineAgent(ctx context.Context, env pipelineAskEnv, blockId string) bool {
	ctx, cancel := context.WithTimeout(ctx, pipelineAskWait)
	defer cancel()
	ticker := time.NewTicker(env.poll)
	defer ticker.Stop()
	for {
		if env.running(blockId) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
		}
	}
}

// pipelineBriefDir: beside the setup's answers, in MoltenTerm's data folder.
func pipelineBriefDir(answersDir string) string {
	if answersDir == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(answersDir), "pipeline-brief")
}
