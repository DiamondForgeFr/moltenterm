// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"strings"
	"testing"
)

// TC-SHELL-047's sample: shapes next to every way an SVG can run code or reach the network.
const maliciousSvg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- exported -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" onload="alert(1)">
  <script>alert(document.cookie)</script>
  <script xlink:href="https://evil.example/x.js"/>
  <style>@import url(https://evil.example/a.css); rect { fill: red }</style>
  <style>.c { fill: url(https://evil.example/p.svg#g) }</style>
  <style>.ok { fill: url(#grad) }</style>
  <defs>
    <linearGradient id="grad"><stop offset="0" stop-color="#ff7c0d"/><stop offset="1" stop-color="#fff"/></linearGradient>
  </defs>
  <rect id="box" class="ok" width="100" height="100" fill="url(#grad)" onclick="alert(2)" style="stroke: url('https://evil.example/s')"/>
  <circle cx="50" cy="50" r="20" fill="url(https://evil.example/f)" stroke="#000" style="stroke-width: 2"/>
  <foreignObject width="100" height="100"><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"/></body></foreignObject>
  <image href="https://evil.example/track.png" width="10" height="10"/>
  <a href="javascript:alert(3)"><path d="M0 0L10 10"/></a>
  <use href="#box" x="5"/>
  <use xlink:href="https://evil.example/sprite.svg#icon"/>
  <use href="java&#x09;script:alert(4)"/>
  <animate attributeName="href" to="javascript:alert(5)"/>
  <set attributeName="onmouseover" to="alert(6)"/>
  <svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(7)</svg:script>
  <x:script xmlns:x="urn:other">alert(8)</x:script>
  <text x="10" y="20" font-family="sans-serif">Client &amp; Co</text>
  <g filter="url(#f)"><feImage href="https://evil.example/i.png"/></g>
</svg>`

func TestSanitizeSvgRemovesActiveAndExternalParts(t *testing.T) {
	out, err := SanitizeSvg([]byte(maliciousSvg))
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	for _, gone := range []string{
		"script", "onload", "onclick", "onmouseover", "alert", "evil.example", "foreignObject", "iframe", "<image",
		"<a ", "javascript", "@import", "<animate", "<set", "feImage", "xlink", "<!--", "<?xml",
	} {
		if strings.Contains(got, gone) {
			t.Fatalf("%q survived:\n%s", gone, got)
		}
	}
	for _, kept := range []string{
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`,
		`<rect id="box" class="ok" width="100" height="100" fill="url(#grad)">`,
		`<circle cx="50" cy="50" r="20" stroke="#000" style="stroke-width: 2">`,
		`<stop offset="0" stop-color="#ff7c0d">`,
		`<style>.ok { fill: url(#grad) }</style>`,
		`<use href="#box" x="5">`,
		`<text x="10" y="20" font-family="sans-serif">Client &amp; Co</text>`,
	} {
		if !strings.Contains(got, kept) {
			t.Fatalf("%q missing:\n%s", kept, got)
		}
	}
	// The result parses again, as the same safe document.
	again, err := SanitizeSvg(out)
	if err != nil || string(again) != got {
		t.Fatalf("not stable: %v\n%s", err, again)
	}
}

func TestSanitizeSvgRefusals(t *testing.T) {
	cases := []struct {
		name   string
		svg    string
		reason string
	}{
		{"doctype", `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"/>`, IconRefusedSvgDoctype},
		{"entity declaration", `<!DOCTYPE svg [<!ENTITY lol "lol">]><svg xmlns="http://www.w3.org/2000/svg">&lol;</svg>`, IconRefusedSvgDoctype},
		{"undeclared entity", `<svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>`, IconRefusedUnreadable},
		{"not svg", `<html xmlns="http://www.w3.org/1999/xhtml"/>`, IconRefusedType},
		{"svg in another namespace", `<svg xmlns="urn:not-svg"/>`, IconRefusedType},
		{"truncated", `<svg xmlns="http://www.w3.org/2000/svg"><rect`, IconRefusedUnreadable},
		{"unclosed", `<svg xmlns="http://www.w3.org/2000/svg"><g>`, IconRefusedUnreadable},
		{"not xml", `<<<>>>`, IconRefusedType},
		{"two roots", `<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>`, IconRefusedUnreadable},
		{"too deep", `<svg xmlns="http://www.w3.org/2000/svg">` + strings.Repeat("<g>", 80) + strings.Repeat("</g>", 80) + `</svg>`, IconRefusedUnreadable},
		{"other encoding", `<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg"/>`, IconRefusedType},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := SanitizeSvg([]byte(tc.svg))
			if got := IconRefusalReason(err); got != tc.reason {
				t.Fatalf("reason %q, want %q (err %v)", got, tc.reason, err)
			}
		})
	}
}

func TestSanitizeSvgValues(t *testing.T) {
	cases := []struct {
		value string
		safe  bool
	}{
		{"#ff7c0d", true},
		{"url(#grad)", true},
		{"url( '#grad' )", true},
		{"url(https://x)", false},
		{"URL(//x)", false},
		{"java\nscript:alert(1)", false},
		{"data:image/png;base64,AAAA", false},
		{"expression(alert(1))", false},
	}
	for _, tc := range cases {
		if got := safeSvgValue(tc.value); got != tc.safe {
			t.Fatalf("%q: safe %v, want %v", tc.value, got, tc.safe)
		}
	}
	for css, safe := range map[string]bool{
		"fill: red":                     true,
		"fill: url(#g)":                 true,
		"@font-face { src: url(#x) }":   false,
		`fill: u\72l(https://x)`:        false,
		"background: url(https://x)":    false,
		"behavior: url(#x); color: red": true,
	} {
		if got := safeSvgCss(css); got != safe {
			t.Fatalf("css %q: safe %v, want %v", css, got, safe)
		}
	}
}
