// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// Bug reports from agents (FR-MORPH-011, DS-MORPH-010): a coding agent searches MoltenTerm's issues, then files a
// report or adds its case to an existing one, through the user's own gh, and only with --yes, which the agent passes
// once the user approved. The rules live in pkg/molten/bugreport.go.

const (
	moltenBugSearchLimit = 10
	moltenBugTimeout     = 30 * time.Second
)

var moltenBugTitle string
var moltenBugWhat string
var moltenBugExpected string
var moltenBugSteps string
var moltenBugRegression int
var moltenBugYes bool
var moltenBugNew bool

var moltenBugCmd = &cobra.Command{
	Use:   "bug",
	Short: "report a MoltenTerm bug to MoltenTerm's developers (search first, file only with the user's approval)",
}

var moltenBugSearchCmd = &cobra.Command{
	Use:   "search <words...>",
	Short: "find MoltenTerm issues about a bug, open and closed, with what to do about each",
	Args:  cobra.MinimumNArgs(1),
	RunE:  moltenWrap(moltenBugSearchRun),
}

var moltenBugReportCmd = &cobra.Command{
	Use:   "report",
	Short: "prepare a bug report; with --yes (after the user approved), file it",
	Args:  cobra.NoArgs,
	RunE:  moltenWrap(moltenBugReportRun),
}

var moltenBugCommentCmd = &cobra.Command{
	Use:   "comment <issue>",
	Short: "add the user's case to an existing issue; with --yes (after the user approved), post it",
	Args:  cobra.ExactArgs(1),
	RunE:  moltenWrap(moltenBugCommentRun),
}

func init() {
	moltenBugReportCmd.Flags().StringVar(&moltenBugTitle, "title", "", "the bug in one line")
	moltenBugReportCmd.Flags().StringVar(&moltenBugExpected, "expected", "", "what should have happened")
	moltenBugReportCmd.Flags().StringVar(&moltenBugSteps, "steps", "", "how to make it happen")
	moltenBugReportCmd.Flags().IntVar(&moltenBugRegression, "regression", 0, "the fixed issue this bug is back from")
	moltenBugReportCmd.Flags().BoolVar(&moltenBugNew, "new", false, "file even though an open issue looks the same")
	for _, cmd := range []*cobra.Command{moltenBugReportCmd, moltenBugCommentCmd} {
		cmd.Flags().StringVar(&moltenBugWhat, "what", "", "what happened")
		cmd.Flags().BoolVar(&moltenBugYes, "yes", false, "the user approved: file it (without it, nothing leaves this machine)")
	}
	moltenCmd.AddCommand(moltenBugCmd)
	for _, cmd := range []*cobra.Command{moltenBugSearchCmd, moltenBugReportCmd, moltenBugCommentCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		moltenBugCmd.AddCommand(cmd)
	}
}

func moltenBugRepo() string {
	if repo := os.Getenv(molten.BugRepoEnvName); repo != "" {
		return repo
	}
	return molten.BugRepo
}

func moltenBugEnvironment() molten.BugEnvironment {
	return molten.BugEnvironment{Version: wavebase.WaveVersion, BuildTime: wavebase.BuildTime, Os: runtime.GOOS, Arch: runtime.GOARCH}
}

// gh, when it is installed and logged in.
func moltenBugGh() string {
	path, err := exec.LookPath("gh")
	if err != nil {
		return ""
	}
	if exec.Command(path, "auth", "status").Run() != nil {
		return ""
	}
	return path
}

func moltenBugGhToken(gh string) string {
	if gh == "" {
		return ""
	}
	out, err := exec.Command(gh, "auth", "token").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// moltenBugFind asks GitHub's issue search, which answers for a public repository without a login.
func moltenBugFind(words string) ([]molten.BugIssue, error) {
	// Bugs only: those users and agents report, and those the developers file under the workflow's bug complexity.
	q := fmt.Sprintf(`%s repo:%s is:issue label:%s,%q`, words, moltenBugRepo(), molten.BugLabel, molten.BugWorkflowLabel)
	ctx, cancel := context.WithTimeout(context.Background(), moltenBugTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/search/issues?per_page="+strconv.Itoa(moltenBugSearchLimit)+"&q="+url.QueryEscape(q), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if token := moltenBugGhToken(moltenBugGh()); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("searching GitHub: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("searching GitHub: %s (log in with gh auth login for a higher limit)", resp.Status)
	}
	var found struct {
		Items []struct {
			Number      int    `json:"number"`
			Title       string `json:"title"`
			State       string `json:"state"`
			StateReason string `json:"state_reason"`
			HtmlUrl     string `json:"html_url"`
			CreatedAt   string `json:"created_at"`
			ClosedAt    string `json:"closed_at"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&found); err != nil {
		return nil, fmt.Errorf("reading GitHub's answer: %w", err)
	}
	issues := make([]molten.BugIssue, 0, len(found.Items))
	for _, it := range found.Items {
		issues = append(issues, molten.BugIssue{Number: it.Number, Title: it.Title, State: it.State, StateReason: it.StateReason,
			Url: it.HtmlUrl, CreatedAt: it.CreatedAt, ClosedAt: it.ClosedAt})
	}
	return issues, nil
}

func moltenBugMatches(words string) ([]molten.BugMatch, error) {
	issues, err := moltenBugFind(words)
	if err != nil {
		return nil, err
	}
	build, ok := molten.ParseBuildTime(wavebase.BuildTime)
	return molten.MatchBugIssues(words, issues, build, ok), nil
}

func printMoltenBugMatches(matches []molten.BugMatch) {
	if len(matches) == 0 {
		WriteStdout("no issue found: report it with molten bug report\n")
		return
	}
	for _, m := range matches {
		WriteStdout("#%d [%s] %s\n    %s\n    %s\n", m.Number, m.State, m.Title, m.Says, m.Url)
	}
}

func moltenBugSearchRun(cmd *cobra.Command, args []string) error {
	words := strings.Join(args, " ")
	matches, err := moltenBugMatches(words)
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(map[string]any{"repo": moltenBugRepo(), "matches": matches})
	}
	printMoltenBugMatches(matches)
	return nil
}

// moltenBugOpen opens a page in the user's browser; the page is printed when it cannot be.
func moltenBugOpen(link string) bool {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", link)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", link)
	default:
		cmd = exec.Command("xdg-open", link)
	}
	return cmd.Run() == nil
}

func moltenBugGhRun(gh string, body string, args ...string) (string, error) {
	cmd := exec.Command(gh, args...)
	cmd.Stdin = strings.NewReader(body)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("gh %s: %s", args[0], strings.TrimSpace(string(out)))
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	return lines[len(lines)-1], nil
}

func moltenBugReportRun(cmd *cobra.Command, args []string) error {
	if strings.TrimSpace(moltenBugTitle) == "" || strings.TrimSpace(moltenBugWhat) == "" {
		return fmt.Errorf("--title and --what are required")
	}
	title := molten.RedactBugText(strings.TrimSpace(moltenBugTitle))
	report := molten.BugReport{Title: title, What: moltenBugWhat, Expected: moltenBugExpected, Steps: moltenBugSteps, Regression: moltenBugRegression}
	body := molten.BugReportBody(report, moltenBugEnvironment())
	labels := []string{molten.BugLabel, molten.BugAgentLabel}
	matches, err := moltenBugMatches(title)
	if err != nil {
		return err
	}
	duplicates := molten.OpenDuplicates(matches)
	result := map[string]any{"repo": moltenBugRepo(), "title": title, "body": body, "labels": labels, "filed": false}
	if len(duplicates) > 0 && !moltenBugNew {
		result["duplicates"] = duplicates
		if moltenJson {
			return moltenWriteJson(result)
		}
		WriteStdout("not filed: an open issue already looks like this bug.\n")
		printMoltenBugMatches(duplicates)
		WriteStdout("add the user's case with molten bug comment <issue> --what \"...\"; if it is a different bug, say why and pass --new.\n")
		return nil
	}
	if !moltenBugYes {
		if moltenJson {
			return moltenWriteJson(result)
		}
		WriteStdout("not filed yet: show this to the user, and run the same command with --yes once they approve.\n\n")
		WriteStdout("repository: %s\nlabels: %s\ntitle: %s\n\n%s", moltenBugRepo(), strings.Join(labels, ", "), title, body)
		return nil
	}
	if gh := moltenBugGh(); gh != "" {
		ghArgs := []string{"issue", "create", "--repo", moltenBugRepo(), "--title", title, "--body-file", "-"}
		for _, label := range labels {
			ghArgs = append(ghArgs, "--label", label)
		}
		link, err := moltenBugGhRun(gh, body, ghArgs...)
		if err != nil {
			return err
		}
		result["filed"] = true
		result["url"] = link
		if moltenJson {
			return moltenWriteJson(result)
		}
		WriteStdout("filed: %s\n", link)
		return nil
	}
	page := molten.NewIssueUrl(moltenBugRepo(), title, body, labels)
	result["page"] = page
	result["opened"] = moltenBugOpen(page)
	if moltenJson {
		return moltenWriteJson(result)
	}
	WriteStdout("gh is not installed or not logged in: the prepared issue is open in the browser, for the user to submit.\n%s\n", page)
	return nil
}

func moltenBugCommentRun(cmd *cobra.Command, args []string) error {
	number, err := strconv.Atoi(strings.TrimPrefix(args[0], "#"))
	if err != nil || number <= 0 {
		return fmt.Errorf("not an issue number: %s", args[0])
	}
	if strings.TrimSpace(moltenBugWhat) == "" {
		return fmt.Errorf("--what is required")
	}
	body := molten.BugCommentBody(moltenBugWhat, moltenBugEnvironment())
	issuePage := fmt.Sprintf("https://github.com/%s/issues/%d", moltenBugRepo(), number)
	result := map[string]any{"repo": moltenBugRepo(), "issue": number, "body": body, "posted": false}
	if !moltenBugYes {
		if moltenJson {
			return moltenWriteJson(result)
		}
		WriteStdout("not posted yet: show this to the user, and run the same command with --yes once they approve.\n\n%s\n%s", issuePage, body)
		return nil
	}
	if gh := moltenBugGh(); gh != "" {
		link, err := moltenBugGhRun(gh, body, "issue", "comment", strconv.Itoa(number), "--repo", moltenBugRepo(), "--body-file", "-")
		if err != nil {
			return err
		}
		result["posted"] = true
		result["url"] = link
		if moltenJson {
			return moltenWriteJson(result)
		}
		WriteStdout("posted: %s\n", link)
		return nil
	}
	result["page"] = issuePage
	result["opened"] = moltenBugOpen(issuePage)
	if moltenJson {
		return moltenWriteJson(result)
	}
	WriteStdout("gh is not installed or not logged in: the issue is open in the browser; paste this as a comment:\n\n%s", body)
	return nil
}
