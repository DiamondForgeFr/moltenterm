// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// phrase is a name or a reason of the integration report: the English (`molten agent integration status`, logs) and
// its code, which the companion words in the interface language (#656).
type phrase struct {
	text    *uimsg.Text
	english string
}

func say(text *uimsg.Text, english string) phrase {
	return phrase{text: text, english: english}
}

func addedItem(kind string, name phrase) molten.IntegrationItem {
	return molten.IntegrationItem{Kind: kind, Name: name.english, NameText: name.text}
}

func skippedItem(kind string, name phrase, reason phrase) molten.IntegrationItem {
	return molten.IntegrationItem{Kind: kind, Name: name.english, NameText: name.text, Reason: reason.english, ReasonText: reason.text}
}

// setStepAside: nothing is added to the run, for reason.
func (p *LaunchPlan) setStepAside(reason phrase) {
	p.StepAside, p.StepAsideText = reason.english, reason.text
}
