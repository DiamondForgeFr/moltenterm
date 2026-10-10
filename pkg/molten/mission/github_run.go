// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	GithubRunLogCommand   = "moltenmissionghrunlog"
	GithubRunRerunCommand = "moltenmissionghrunrerun"
	githubRunTimeout      = 45 * time.Second
	// The tail a row's log shows: the end of a log is where a job fails.
	maxGithubRunLog = 256 << 10
)

type GithubRunRequest struct {
	Dir    string `json:"dir"`
	RunId  int64  `json:"runid"`
	Failed bool   `json:"failed,omitempty"`
}

type GithubRunLog struct {
	Text string `json:"text"`
	// Only the failed jobs' steps: the run failed and GitHub kept their logs apart.
	FailedOnly bool `json:"failedonly,omitempty"`
	Truncated  bool `json:"truncated,omitempty"`
}

func checkGithubRun(req GithubRunRequest) error {
	if err := checkDir(req.Dir); err != nil {
		return err
	}
	if req.RunId <= 0 {
		return fmt.Errorf("a GitHub run id is a positive number (got %d)", req.RunId)
	}
	return nil
}

// ReadGithubRunLog reads a GitHub Actions run's log through gh (FR-SHELL-057, the CI/CD rows' Logs): the failed
// steps only when the run failed, since they hold the answer, else the whole log; its tail when it is long.
func (c *Collector) ReadGithubRunLog(req GithubRunRequest) (GithubRunLog, error) {
	if err := checkGithubRun(req); err != nil {
		return GithubRunLog{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), githubRunTimeout)
	defer cancel()
	dir := filepath.Clean(req.Dir)
	id := strconv.FormatInt(req.RunId, 10)
	var out []byte
	var err error
	failedOnly := false
	if req.Failed {
		out, err = c.run(ctx, dir, "gh", "run", "view", id, "--log-failed")
		failedOnly = err == nil && strings.TrimSpace(string(out)) != ""
	}
	if !failedOnly {
		out, err = c.run(ctx, dir, "gh", "run", "view", id, "--log")
		if err != nil {
			return GithubRunLog{}, err
		}
	}
	text := string(out)
	truncated := false
	if len(text) > maxGithubRunLog {
		text = text[len(text)-maxGithubRunLog:]
		if nl := strings.IndexByte(text, '\n'); nl >= 0 {
			text = text[nl+1:]
		}
		truncated = true
	}
	return GithubRunLog{Text: text, FailedOnly: failedOnly, Truncated: truncated}, nil
}

// RerunGithubRun starts a GitHub Actions run again (FR-SHELL-057, the CI/CD rows' Rerun, after the user confirmed in
// the window): only its failed jobs when asked, which is what a red run needs.
func (c *Collector) RerunGithubRun(req GithubRunRequest) error {
	if err := checkGithubRun(req); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), githubRunTimeout)
	defer cancel()
	args := []string{"run", "rerun", strconv.FormatInt(req.RunId, 10)}
	if req.Failed {
		args = append(args, "--failed")
	}
	_, err := c.run(ctx, filepath.Clean(req.Dir), "gh", args...)
	return err
}
