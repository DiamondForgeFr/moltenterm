// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"errors"
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Every control bar line this package writes reads back as its code (#656).
func TestActionText(t *testing.T) {
	button := targetInfo{Found: true, Kind: "button", Label: "Sign in"}
	cases := []struct {
		line string
		code string
		vars map[string]string
	}{
		{actionBack, "browser.action.back", nil},
		{actionForward, "browser.action.forward", nil},
		{actionReadPage, "browser.action.readpage", nil},
		{actionPageText, "browser.action.pagetext", nil},
		{actionFind, "browser.action.find", nil},
		{actionScreenshot, "browser.action.screenshot", nil},
		{actionZoom, "browser.action.zoom", nil},
		{actionWait, "browser.action.wait", nil},
		{actionOpened, "browser.action.opened", nil},
		{actionEngaged, "browser.action.engaged", nil},
		{fmt.Sprintf(actionNavigate, "example.com"), "browser.action.navigate", map[string]string{"site": "example.com"}},
		{actionLine("Clicked", button, 1, 2, true), "browser.action.clickedon", map[string]string{"on": `button "Sign in"`}},
		{actionLine("Right-clicked", targetInfo{}, 10, 20, true), "browser.action.rightclickedon", map[string]string{"on": "at (10, 20)"}},
		{actionLine("Double-clicked", button, 0, 0, false), "browser.action.doubleclickedon", map[string]string{"on": `button "Sign in"`}},
		{actionLine("Triple-clicked", targetInfo{}, 0, 0, false), "browser.action.tripleclicked", nil},
		{actionLine("Hovered over", button, 0, 0, false), "browser.action.hoveredon", map[string]string{"on": `button "Sign in"`}},
		{actionLine("Scrolled to", button, 0, 0, false), "browser.action.scrolledtoon", map[string]string{"on": `button "Sign in"`}},
		{actionLine("Typing in", targetInfo{Kind: "textbox"}, 0, 0, false), "browser.action.typingon", map[string]string{"on": "textbox"}},
		{actionLine("Set", button, 0, 0, false), "browser.action.seton", map[string]string{"on": `button "Sign in"`}},
		{"Scrolled " + scrollWord(inputPlan{dy: -1}), "browser.action.scrolledup", nil},
		{"Scrolled " + scrollWord(inputPlan{dx: 1}), "browser.action.scrolledright", nil},
		{actionPressedPrefix + "Enter ×2", "browser.action.pressed", map[string]string{"keys": "Enter ×2"}},
		{fmt.Sprintf(actionDragFormat, 1, 2, 3, 4), "browser.action.dragged", map[string]string{"from": "(1, 2)", "to": "(3, 4)"}},
		{fmt.Sprintf(actionResizeFormat, 390, 844), "browser.action.resized", map[string]string{"size": "390 × 844"}},
	}
	for _, c := range cases {
		text := actionText(c.line)
		if text == nil || text.Code != c.code || fmt.Sprint(text.Vars) != fmt.Sprint(c.vars) {
			t.Errorf("%q: got %+v, want %s %v", c.line, text, c.code, c.vars)
		}
	}
	if actionText("") != nil || actionText("an unknown line") != nil {
		t.Fatal("an empty or unknown line got a code")
	}
}

func TestShareErrorsAreCoded(t *testing.T) {
	for _, msg := range []string{errShareNotUi, errShareTabGone, errShareOtherEngine, errShareSessionGone, errShareElsewhere,
		errShareOtherTab, errShareNotShared, errShareNoPage, errShareTooManyTabs, errSharePanelUnknown} {
		err := shareError(msg)
		var coded *uimsg.Error
		if err.Error() != msg || !errors.As(err, &coded) || coded.Text == nil || coded.Text.Code == "" {
			t.Errorf("%q: %v", msg, err)
		}
	}
}

func TestActionPromptCode(t *testing.T) {
	for _, reason := range []string{reasonSensitiveField, reasonSensitiveFill, reasonFrameField, reasonSensitiveForm, reasonFileChooser, reasonDownload, "other"} {
		if text := actionPromptCode(reason); text == nil || text.Code == "" {
			t.Errorf("%q has no code", reason)
		}
	}
}
