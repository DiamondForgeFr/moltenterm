// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mcpbrowser

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Handing work to another agent by first name (FR-CONT-015). The tools live on this server because it is the one
// MoltenTerm's launcher gives Claude Code and Codex, but they are not browser tools: `molten mcp browser` sends them to
// wavesrv's handoff route (pkg/molten/agenthandoff) with the pane's token, and browser_batch never runs them.

const (
	ToolListAgents  = "list_agents"
	ToolSendToAgent = "send_to_agent"
)

// AgentTools returns the handoff tools, in a stable order.
func AgentTools() []ToolDef {
	fileSchema := objectSchema(map[string]any{
		"path":    map[string]any{"type": "string", "description": "The file's absolute path."},
		"project": map[string]any{"type": "string", "description": "The project the file belongs to."},
		"lines":   map[string]any{"type": "string", "description": "A line or a range such as \"40-60\": MoltenTerm quotes these lines in the brief."},
		"excerpt": map[string]any{"type": "string", "description": "A short excerpt to show in the brief."},
		"note":    map[string]any{"type": "string", "description": "Why the receiver needs this file."},
	}, []string{"path"})
	linkSchema := objectSchema(map[string]any{
		"url":   map[string]any{"type": "string", "description": "The address: a ticket, a pull request, an SRS page or any URL."},
		"title": map[string]any{"type": "string", "description": "What the link is."},
		"kind": map[string]any{
			"type":        "string",
			"enum":        []string{"ticket", "pr", "srs", "url", "browser"},
			"description": "ticket, pr, srs, url, or browser for a page the receiver should open in its own MoltenTerm browser panel.",
		},
		"tabId": map[string]any{"type": "integer", "description": "One of your MoltenTerm browser tabs (from tabs_context): MoltenTerm reads its page's address and title. The receiver opens the page in its own panel; your tab is not shared."},
		"note":  map[string]any{"type": "string", "description": "Why the receiver needs this link."},
	}, nil)
	return []ToolDef{
		{
			Name:  ToolListAgents,
			Title: "List the agents you can hand work to",
			Description: "Lists the coding agents running now in MoltenTerm's terminals, with their first name, agent, project, " +
				"workspace, tab and state; your own entry is marked you, with your first name. Call it before send_to_agent, " +
				"to find the agent the user named. Subagents have no first name and are not listed.",
			InputSchema: objectSchema(map[string]any{}, nil),
			Annotations: &ToolAnnotations{Title: "List the agents you can hand work to", ReadOnlyHint: true, OpenWorldHint: false},
		},
		{
			Name:  ToolSendToAgent,
			Title: "Hand work to another agent",
			Description: "Hands work to another agent by its first name, when the user asks (\"send this to Jérôme\"). MoltenTerm " +
				"writes your brief as Markdown in its own data folder (never in a project) and types a short prompt in the " +
				"receiver's terminal: \"[From <your name> · <agent> · <project>] <goal>\" with the brief's path. The receiver " +
				"must be able to start from the brief alone, without asking back: fill goal (what to do and the expected " +
				"result), context (what was done so far, decisions and why, constraints, open questions), files (absolute " +
				"paths with their project, line ranges or excerpts that matter) and links (tickets, PRs, SRS pages, URLs, and " +
				"browser pages by url or by the tabId of your MoltenTerm browser tab). Set reply when you expect an answer: " +
				"the receiver then answers with send_to_agent. Files outside the receiver's project are copied next to the " +
				"brief. The first send between two agents asks the user (allow once, always for this pair, block): the call " +
				"waits up to 50 seconds for the answer. Without an answer by then the result's status is \"pending\": the " +
				"request stays with the user, nothing is sent until they allow it, and MoltenTerm types the outcome in your " +
				"terminal (a line starting with [MoltenTerm]) once they answer; do not send it again. A busy receiver gets " +
				"the prompt when its prompt is idle.",
			InputSchema: objectSchema(map[string]any{
				"name": map[string]any{"type": "string", "description": "The receiver's first name (see list_agents)."},
				"brief": objectSchema(map[string]any{
					"goal":    map[string]any{"type": "string", "description": "What the receiver must do, and the expected result."},
					"context": map[string]any{"type": "string", "description": "What was done so far, decisions taken and why, constraints, open questions."},
					"files":   map[string]any{"type": "array", "items": fileSchema, "description": "The files the receiver needs."},
					"links":   map[string]any{"type": "array", "items": linkSchema, "description": "Tickets, pull requests, SRS pages, URLs and browser pages."},
					"reply":   map[string]any{"type": "boolean", "description": "true when you expect the receiver to answer you."},
				}, []string{"goal"}),
			}, []string{"name", "brief"}),
			Annotations: &ToolAnnotations{Title: "Hand work to another agent", OpenWorldHint: false},
		},
	}
}

// IsAgentTool tells the handoff tools apart from the browser's.
func IsAgentTool(name string) bool {
	return name == ToolListAgents || name == ToolSendToAgent
}

// SignInstructions: agents use the developer's GitHub account, so their work carries who made it (#847,
// pkg/molten/agentdocs/pr-signature.md).
const SignInstructions = " Sign your work: add the trailer `molten agent whoami --trailer` prints to each commit you " +
	"make (git commit --trailer \"$(molten agent whoami --trailer)\"), and run `molten agent sign-pr <number>` after " +
	"opening a pull request or pushing to one. Details: pr-signature.md in the folder `molten docs` prints."

// AgentInstructions completes the server's instructions with the agent's own first name (FR-CONT-014): Claude Code
// puts server instructions in its system prompt, so the agent can sign its briefs and knows it is addressed.
func AgentInstructions(firstName string) string {
	rtn := " To hand work to another agent when the user asks (\"send this to Jérôme\"), call list_agents, then " +
		"send_to_agent with a brief the receiver can act on alone."
	if firstName != "" {
		rtn = fmt.Sprintf(" In MoltenTerm your first name is %s: the user and other agents call you by it, and handoffs you "+
			"send are signed with it.", firstName) + rtn + SignInstructions
	}
	return rtn
}

// AgentListEntry mirrors agenthandoff.AgentEntry (this package does not depend on wavesrv).
type AgentListEntry struct {
	FirstName string `json:"firstname"`
	AgentName string `json:"agentname"`
	State     string `json:"state,omitempty"`
	Project   string `json:"project,omitempty"`
	Folder    string `json:"folder,omitempty"`
	Workspace string `json:"workspace,omitempty"`
	Tab       string `json:"tab,omitempty"`
	You       bool   `json:"you,omitempty"`
}

type AgentList struct {
	You    *AgentListEntry  `json:"you,omitempty"`
	Agents []AgentListEntry `json:"agents"`
}

// FormatAgentList is list_agents' text: one line per agent, yours first.
func FormatAgentList(list AgentList) string {
	var sb strings.Builder
	if list.You != nil && list.You.FirstName != "" {
		fmt.Fprintf(&sb, "You are %s (%s).\n", list.You.FirstName, list.You.AgentName)
	}
	others := 0
	for _, a := range list.Agents {
		if a.You {
			continue
		}
		others++
	}
	if others == 0 {
		sb.WriteString("No other agent is running in MoltenTerm.")
		return sb.String()
	}
	sb.WriteString("Agents you can hand work to (send_to_agent with the first name):\n")
	for _, a := range list.Agents {
		if a.You {
			continue
		}
		fmt.Fprintf(&sb, "- %s: %s", a.FirstName, a.AgentName)
		if a.Project != "" {
			fmt.Fprintf(&sb, ", project %s", a.Project)
		}
		if a.Workspace != "" {
			fmt.Fprintf(&sb, ", workspace \"%s\"", a.Workspace)
		}
		if a.Tab != "" {
			fmt.Fprintf(&sb, ", tab \"%s\"", a.Tab)
		}
		if a.State != "" {
			fmt.Fprintf(&sb, ", %s", a.State)
		}
		if a.Folder != "" {
			fmt.Fprintf(&sb, " (%s)", a.Folder)
		}
		sb.WriteString("\n")
	}
	return strings.TrimRight(sb.String(), "\n")
}

// SendToAgentArgs is send_to_agent's input; Brief goes to wavesrv as it came, checked there.
type SendToAgentArgs struct {
	Name  string          `json:"name"`
	Brief json.RawMessage `json:"brief"`
}
