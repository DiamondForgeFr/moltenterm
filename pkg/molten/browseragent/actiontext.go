// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The control bar's line in the interface language (#656). Every line is one of the forms this package writes (the
// action constants, actionLine and the input tools' own lines), so its code is read back from it here rather than
// carried through every tool. A page's labels stay as they are: they are the {on} of the line.

// The verbs actionLine is called with: the line of the verb alone, and with its target or point.
var actionVerbs = []struct {
	verb string
	bare func() *uimsg.Text
	on   func(on string) *uimsg.Text
}{
	{"Right-clicked",
		func() *uimsg.Text { return uimsg.Make("browser.action.rightclicked") },
		func(on string) *uimsg.Text { return uimsg.Make("browser.action.rightclickedon", "on", on) }},
	{"Double-clicked",
		func() *uimsg.Text { return uimsg.Make("browser.action.doubleclicked") },
		func(on string) *uimsg.Text { return uimsg.Make("browser.action.doubleclickedon", "on", on) }},
	{"Triple-clicked",
		func() *uimsg.Text { return uimsg.Make("browser.action.tripleclicked") },
		func(on string) *uimsg.Text { return uimsg.Make("browser.action.tripleclickedon", "on", on) }},
	{"Clicked",
		func() *uimsg.Text { return uimsg.Make("browser.action.clicked") },
		func(on string) *uimsg.Text { return uimsg.Make("browser.action.clickedon", "on", on) }},
	{"Hovered over",
		func() *uimsg.Text { return uimsg.Make("browser.action.hovered") },
		func(on string) *uimsg.Text { return uimsg.Make("browser.action.hoveredon", "on", on) }},
	{"Scrolled to",
		func() *uimsg.Text { return uimsg.Make("browser.action.scrolledto") },
		func(on string) *uimsg.Text { return uimsg.Make("browser.action.scrolledtoon", "on", on) }},
	{"Typing in",
		func() *uimsg.Text { return uimsg.Make("browser.action.typing") },
		func(on string) *uimsg.Text { return uimsg.Make("browser.action.typingon", "on", on) }},
	{"Set",
		func() *uimsg.Text { return uimsg.Make("browser.action.set") },
		func(on string) *uimsg.Text { return uimsg.Make("browser.action.seton", "on", on) }},
}

func fixedActionText(action string) *uimsg.Text {
	switch action {
	case actionBack:
		return uimsg.Make("browser.action.back")
	case actionForward:
		return uimsg.Make("browser.action.forward")
	case actionReadPage:
		return uimsg.Make("browser.action.readpage")
	case actionPageText:
		return uimsg.Make("browser.action.pagetext")
	case actionFind:
		return uimsg.Make("browser.action.find")
	case actionScreenshot:
		return uimsg.Make("browser.action.screenshot")
	case actionZoom:
		return uimsg.Make("browser.action.zoom")
	case actionWait:
		return uimsg.Make("browser.action.wait")
	case actionOpened:
		return uimsg.Make("browser.action.opened")
	case actionEngaged:
		return uimsg.Make("browser.action.engaged")
	case "Scrolled up":
		return uimsg.Make("browser.action.scrolledup")
	case "Scrolled down":
		return uimsg.Make("browser.action.scrolleddown")
	case "Scrolled left":
		return uimsg.Make("browser.action.scrolledleft")
	case "Scrolled right":
		return uimsg.Make("browser.action.scrolledright")
	}
	return nil
}

const (
	actionNavigatePrefix = "Went to "
	actionPressedPrefix  = "Pressed "
	actionDragFormat     = "Dragged from (%d, %d) to (%d, %d)"
	actionResizeFormat   = "Resized the page to %d×%d"
)

// actionText is the code of a control bar line, nil for "" or a line this package does not write.
func actionText(action string) *uimsg.Text {
	if action == "" {
		return nil
	}
	if text := fixedActionText(action); text != nil {
		return text
	}
	if site, ok := strings.CutPrefix(action, actionNavigatePrefix); ok {
		return uimsg.Make("browser.action.navigate", "site", site)
	}
	for _, v := range actionVerbs {
		if action == v.verb {
			return v.bare()
		}
		if on, ok := strings.CutPrefix(action, v.verb+" "); ok {
			return v.on(on)
		}
	}
	if keys, ok := strings.CutPrefix(action, actionPressedPrefix); ok {
		return uimsg.Make("browser.action.pressed", "keys", keys)
	}
	var x1, y1, x2, y2 int
	if n, _ := fmt.Sscanf(action, actionDragFormat, &x1, &y1, &x2, &y2); n == 4 && fmt.Sprintf(actionDragFormat, x1, y1, x2, y2) == action {
		return uimsg.Make("browser.action.dragged", "from", fmt.Sprintf("(%d, %d)", x1, y1), "to", fmt.Sprintf("(%d, %d)", x2, y2))
	}
	var w, h int
	if n, _ := fmt.Sscanf(action, actionResizeFormat, &w, &h); n == 2 && fmt.Sprintf(actionResizeFormat, w, h) == action {
		return uimsg.Make("browser.action.resized", "size", fmt.Sprintf("%d × %d", w, h))
	}
	return nil
}
