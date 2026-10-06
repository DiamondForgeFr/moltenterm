// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

const (
	ClaudeUsagePageURL = "https://claude.ai/settings/usage"
	CodexUsagePageURL  = "https://chatgpt.com/codex/settings/usage"
)

// pageAdapter is an agent known by its usage page; the gauges sources of #261 to #263 go in its sources, best first.
type pageAdapter struct {
	id       string
	pageURL  string
	pageName string
	domain   string
	sources  []GaugesSource
}

func (a *pageAdapter) Id() string              { return a.id }
func (a *pageAdapter) PageURL() string         { return a.pageURL }
func (a *pageAdapter) PageName() string        { return a.pageName }
func (a *pageAdapter) Domain() string          { return a.domain }
func (a *pageAdapter) Sources() []GaugesSource { return a.sources }

// MakeClaudeUsageAdapter: Claude Code's plan usage is on claude.ai's usage settings; its gauges come from its
// documented status line input.
func MakeClaudeUsageAdapter() UsageAdapter {
	return &pageAdapter{
		id:       "claude",
		pageURL:  ClaudeUsagePageURL,
		pageName: "Claude usage",
		domain:   "claude.ai",
		sources:  []GaugesSource{MakeClaudeStatusLineSource(DefaultStatusLineStore, claudeStatusLineSetup), DefaultClaudeOAuthSource},
	}
}

// MakeCodexUsageAdapter: Codex's plan usage is on ChatGPT's Codex usage settings; its gauges come from its session
// log, else its app-server (codex.go).
func MakeCodexUsageAdapter() UsageAdapter {
	return &pageAdapter{id: "codex", pageURL: CodexUsagePageURL, pageName: "Codex usage", domain: "chatgpt.com",
		sources: []GaugesSource{MakeCodexTranscriptSource(DefaultCodexUsage), MakeCodexAppServerSource(DefaultCodexUsage)}}
}
