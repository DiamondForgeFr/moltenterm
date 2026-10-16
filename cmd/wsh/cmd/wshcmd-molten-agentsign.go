// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/agentsign"
	"github.com/wavetermdev/waveterm/pkg/molten/handoffwire"
)

// Who made a PR (#847): agents commit and open PRs with the developer's GitHub account, so they sign their work.
// `molten agent whoami` prints the signature of the agent in this terminal (its first name in MoltenTerm, its CLI and
// the model and effort it last reported), `--trailer` the commit trailer; `molten agent sign-pr` writes it at the end
// of a PR's body. Outside MoltenTerm, or before MoltenTerm saw the agent, there is no signature: nothing is guessed.

const moltenSignPrTimeout = time.Minute

var moltenWhoamiTrailer bool

// MoltenWhoami is `molten agent whoami --json`.
type MoltenWhoami struct {
	agentsign.Signature
	Line    string `json:"line"`
	Trailer string `json:"trailer"`
	// ModelId: the model's id when the agent reported a display name too.
	ModelId string `json:"modelid,omitempty"`
}

var moltenAgentWhoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "print the signature of the agent in this terminal: first name, agent, model and effort (--trailer: the commit trailer)",
	Long: "Print who the agent running in this terminal is, as MoltenTerm knows it: its first name, the agent CLI, and\n" +
		"the model and effort it last reported (left out when unknown). Agents sign their commits with\n" +
		"git commit --trailer \"$(molten agent whoami --trailer)\" and their PRs with molten agent sign-pr.",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenAgentWhoamiRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenAgentSignPrCmd = &cobra.Command{
	Use:   "sign-pr <number>",
	Short: "write this terminal's agent at the end of a pull request's body (Made by …), keeping the agents who worked on it before",
	Long: "Put the signature block at the end of the pull request's body, through your gh: \"Made by <you>\", the earlier\n" +
		"agents under \"Earlier:\", and the developer's \"Reviewed by\" line when MoltenTerm wrote one. Run it after\n" +
		"opening the PR and after each later round of work. Run from the project's folder.",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenAgentSignPrRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenAgentWhoamiCmd.Flags().BoolVar(&moltenJson, "json", false, "print the signature as JSON")
	moltenAgentWhoamiCmd.Flags().BoolVar(&moltenWhoamiTrailer, "trailer", false, "print the commit trailer only (Molten-Agent: …)")
	moltenAgentSignPrCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	moltenAgentCmd.AddCommand(moltenAgentWhoamiCmd)
	moltenAgentCmd.AddCommand(moltenAgentSignPrCmd)
}

// moltenSignatureOf: the model's display name when the agent gave one, else its id.
func moltenSignatureOf(e handoffwire.AgentEntry) agentsign.Signature {
	model := e.ModelName
	if model == "" {
		model = e.Model
	}
	return agentsign.Signature{FirstName: e.FirstName, Agent: e.AgentName, Model: model, Effort: e.Effort}
}

func moltenWhoamiOf(list handoffwire.ListResult) (MoltenWhoami, error) {
	if list.You == nil || list.You.FirstName == "" {
		return MoltenWhoami{}, fmt.Errorf("MoltenTerm sees no agent with a first name in this terminal: no signature (nothing is guessed)")
	}
	sig := moltenSignatureOf(*list.You)
	rtn := MoltenWhoami{Signature: sig, Line: sig.Line(), Trailer: sig.Trailer()}
	if list.You.ModelName != "" && list.You.Model != list.You.ModelName {
		rtn.ModelId = list.You.Model
	}
	return rtn, nil
}

func moltenWhoami() (MoltenWhoami, error) {
	token, err := moltenHandoffToken()
	if err != nil {
		return MoltenWhoami{}, err
	}
	var list handoffwire.ListResult
	err = moltenHandoffRequest(handoffwire.ListCommand, handoffwire.ListRequest{Token: token, WaitName: true}, moltenHandoffListTimeoutMs, &list)
	if err != nil {
		return MoltenWhoami{}, fmt.Errorf("%s", moltenHandoffError(err))
	}
	return moltenWhoamiOf(list)
}

func formatMoltenWhoami(w MoltenWhoami) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s\n", w.Line)
	fmt.Fprintf(&sb, "name:    %s\n", moltenDash(w.FirstName))
	fmt.Fprintf(&sb, "agent:   %s\n", moltenDash(w.Agent))
	model := moltenDash(w.Model)
	if w.ModelId != "" {
		model += " (" + w.ModelId + ")"
	}
	fmt.Fprintf(&sb, "model:   %s\n", model)
	fmt.Fprintf(&sb, "effort:  %s\n", moltenDash(w.Effort))
	fmt.Fprintf(&sb, "trailer: %s\n", w.Trailer)
	return sb.String()
}

func moltenAgentWhoamiRun(cmd *cobra.Command, args []string) error {
	w, err := moltenWhoami()
	if err != nil {
		return err
	}
	switch {
	case moltenJson:
		return moltenWriteJson(w)
	case moltenWhoamiTrailer:
		WriteStdout("%s\n", w.Trailer)
	default:
		WriteStdout("%s", formatMoltenWhoami(w))
	}
	return nil
}

// MoltenSignPr is `molten agent sign-pr --json`.
type MoltenSignPr struct {
	Number    int                   `json:"number"`
	Signature agentsign.Signature   `json:"signature"`
	Agents    []agentsign.Signature `json:"agents"`
	Changed   bool                  `json:"changed"`
}

func moltenGh(ctx context.Context, args ...string) ([]byte, error) {
	out, err := exec.CommandContext(ctx, "gh", args...).Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && len(exitErr.Stderr) > 0 {
			return nil, fmt.Errorf("gh %s: %s", args[0]+" "+args[1], strings.TrimSpace(string(exitErr.Stderr)))
		}
		return nil, fmt.Errorf("gh %s: %v", args[0]+" "+args[1], err)
	}
	return out, nil
}

func moltenAgentSignPrRun(cmd *cobra.Command, args []string) error {
	number, err := strconv.Atoi(strings.TrimPrefix(args[0], "#"))
	if err != nil || number <= 0 {
		return fmt.Errorf("%q is not a pull request number", args[0])
	}
	w, err := moltenWhoami()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), moltenSignPrTimeout)
	defer cancel()
	out, err := moltenGh(ctx, "pr", "view", strconv.Itoa(number), "--json", "body")
	if err != nil {
		return err
	}
	var pr struct {
		Body string `json:"body"`
	}
	if err := json.Unmarshal(out, &pr); err != nil {
		return fmt.Errorf("gh pr view: unreadable answer")
	}
	body := agentsign.WithAgent(pr.Body, w.Signature)
	rtn := MoltenSignPr{Number: number, Signature: w.Signature, Changed: body != pr.Body}
	block, _ := agentsign.ParseBlock(body)
	rtn.Agents = block.Agents
	if rtn.Changed {
		if _, err := moltenGh(ctx, "pr", "edit", strconv.Itoa(number), "--body", body); err != nil {
			return err
		}
	}
	if moltenJson {
		return moltenWriteJson(rtn)
	}
	if rtn.Changed {
		WriteStdout("PR #%d: Made by %s\n", number, w.Line)
	} else {
		WriteStdout("PR #%d already says Made by %s\n", number, w.Line)
	}
	return nil
}
