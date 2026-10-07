// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"regexp"
	"slices"
	"strings"
)

// The SVG sanitiser of DS-SHELL-039: the document is parsed and rebuilt from an allow-list, never patched with a
// deny-list. What is not known to be inert is dropped: scripts, event handlers, foreignObject, links, animations,
// external references of any kind (href, url(), @import), and anything outside the SVG namespace. A DOCTYPE or an
// entity refuses the whole file. The result is still only ever shown through an image element, where scripts do not
// run (FR-SHELL-031 AC4); the sanitiser is the second wall.

const (
	svgNamespace   = "http://www.w3.org/2000/svg"
	xlinkNamespace = "http://www.w3.org/1999/xlink"
	xmlNamespace   = "http://www.w3.org/XML/1998/namespace"
	maxSvgDepth    = 64
	maxSvgElements = 20000
	maxSvgUses     = 256
)

var svgAllowedElements = toSet(
	"svg", "g", "defs", "symbol", "use", "title", "desc", "style",
	"path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan",
	"linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "marker",
	"filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix",
	"feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB",
	"feFuncG", "feFuncR", "feGaussianBlur", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
	"feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
)

// Text is kept only where it is content.
var svgTextElements = toSet("text", "tspan", "title", "desc", "style")

var svgAllowedAttrs = toSet(
	"id", "class", "style", "href", "version", "viewBox", "preserveAspectRatio", "width", "height", "x", "y",
	"x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "d", "points", "pathLength",
	"transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap",
	"stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity",
	"color", "display", "visibility", "overflow", "clip-path", "clip-rule", "mask", "filter", "gradientUnits",
	"gradientTransform", "spreadMethod", "offset", "stop-color", "stop-opacity", "clipPathUnits", "maskUnits",
	"maskContentUnits", "patternUnits", "patternContentUnits", "patternTransform", "markerWidth", "markerHeight",
	"markerUnits", "refX", "refY", "orient", "marker-start", "marker-mid", "marker-end", "font-family",
	"font-size", "font-weight", "font-style", "font-variant", "font-stretch", "text-anchor", "dominant-baseline",
	"alignment-baseline", "baseline-shift", "letter-spacing", "word-spacing", "text-decoration", "dx", "dy",
	"rotate", "textLength", "lengthAdjust", "filterUnits", "primitiveUnits", "in", "in2", "result",
	"stdDeviation", "mode", "type", "values", "operator", "k1", "k2", "k3", "k4", "flood-color",
	"flood-opacity", "lighting-color", "color-interpolation-filters", "color-interpolation", "shape-rendering",
	"text-rendering", "image-rendering", "vector-effect", "paint-order", "mix-blend-mode", "isolation",
	"tableValues", "slope", "intercept", "amplitude", "exponent", "order", "kernelMatrix", "divisor", "bias",
	"targetX", "targetY", "edgeMode", "preserveAlpha", "radius", "scale", "xChannelSelector",
	"yChannelSelector", "baseFrequency", "numOctaves", "seed", "stitchTiles", "surfaceScale", "diffuseConstant",
	"specularConstant", "specularExponent", "kernelUnitLength", "azimuth", "elevation", "z", "pointsAtX",
	"pointsAtY", "pointsAtZ", "limitingConeAngle", "media",
)

var localRefRe = regexp.MustCompile(`^#[A-Za-z_][A-Za-z0-9_.:-]*$`)
var cssUrlRe = regexp.MustCompile(`url\(`)
var invisibleRe = regexp.MustCompile(`[\x00-\x20\x7f]+`)
var cssFunctionRe = regexp.MustCompile(`([a-z0-9_-]*)\(`)

// The only functions a value may call: colours, maths, transforms and filter effects. Anything that takes a resource
// (image-set, image, src, cross-fade, element, -webkit-image-set…) is not on the list; url() is, for a local #id only.
var svgAllowedFunctions = toSet(
	"", "url", "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "var",
	"calc", "min", "max", "clamp", "matrix", "matrix3d", "translate", "translatex", "translatey", "translate3d",
	"scale", "scalex", "scaley", "scale3d", "rotate", "rotatex", "rotatey", "rotate3d", "skew", "skewx", "skewy",
	"perspective", "blur", "brightness", "contrast", "drop-shadow", "grayscale", "hue-rotate", "invert", "opacity",
	"saturate", "sepia",
)

func toSet(values ...string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, v := range values {
		set[v] = true
	}
	return set
}

// Lowercased, without the whitespace and control characters a browser skips inside "java\tscript:".
func squashValue(value string) string {
	return invisibleRe.ReplaceAllString(strings.ToLower(value), "")
}

// Every url( must point to a local #id.
func onlyLocalUrls(squashed string) bool {
	for _, loc := range cssUrlRe.FindAllStringIndex(squashed, -1) {
		rest := strings.TrimLeft(squashed[loc[1]:], `"'`)
		if !strings.HasPrefix(rest, "#") {
			return false
		}
	}
	return true
}

func onlyAllowedFunctions(squashed string) bool {
	for _, match := range cssFunctionRe.FindAllStringSubmatch(squashed, -1) {
		if !svgAllowedFunctions[match[1]] {
			return false
		}
	}
	return true
}

func safeSvgValue(value string) bool {
	squashed := squashValue(value)
	for _, bad := range []string{"javascript:", "vbscript:", "data:", "expression(", "@import", "<", "&#"} {
		if strings.Contains(squashed, bad) {
			return false
		}
	}
	return onlyAllowedFunctions(squashed) && onlyLocalUrls(squashed)
}

// CSS gets a stricter rule than an attribute: no at-rule and no escape at all, since an escape can spell any of the
// words above.
func safeSvgCss(css string) bool {
	squashed := squashValue(css)
	if strings.ContainsAny(squashed, `@\`) {
		return false
	}
	return safeSvgValue(css)
}

type svgWriter struct {
	out bytes.Buffer
}

func (w *svgWriter) escaped(text string) {
	xml.EscapeText(&w.out, []byte(text))
}

func (w *svgWriter) start(local string, attrs []xml.Attr, root bool) {
	w.out.WriteString("<" + local)
	if root {
		w.out.WriteString(` xmlns="` + svgNamespace + `"`)
	}
	for _, attr := range attrs {
		name := attr.Name.Local
		if attr.Name.Space == xmlNamespace {
			name = "xml:" + name
		}
		w.out.WriteString(" " + name + `="`)
		w.escaped(attr.Value)
		w.out.WriteString(`"`)
	}
	w.out.WriteString(">")
}

func (w *svgWriter) end(local string) {
	w.out.WriteString("</" + local + ">")
}

// root drops the outermost svg's id: a <use> pointing at the whole document would instantiate every other <use>.
func keepSvgAttrs(local string, attrs []xml.Attr, root bool) []xml.Attr {
	var kept []xml.Attr
	seen := make(map[string]bool)
	for _, attr := range attrs {
		name := attr.Name
		if name.Space == xmlNamespace && name.Local == "space" {
			kept = append(kept, attr)
			continue
		}
		if name.Space == xlinkNamespace && name.Local == "href" {
			name = xml.Name{Local: "href"}
		} else if name.Space != "" {
			continue
		}
		if strings.HasPrefix(strings.ToLower(name.Local), "on") || !svgAllowedAttrs[name.Local] {
			continue
		}
		// A repeated attribute (href and xlink:href both become href) would make the file malformed.
		if seen[name.Local] || (root && name.Local == "id") {
			continue
		}
		if local == "style" && name.Local != "type" && name.Local != "media" && name.Local != "id" {
			continue
		}
		value := attr.Value
		switch {
		case name.Local == "href":
			value = strings.TrimSpace(value)
			if !localRefRe.MatchString(value) {
				continue
			}
		case name.Local == "style":
			if !safeSvgCss(value) {
				continue
			}
		default:
			if !safeSvgValue(value) {
				continue
			}
		}
		seen[name.Local] = true
		kept = append(kept, xml.Attr{Name: name, Value: value})
	}
	return kept
}

// A <style> element is held until its end: kept whole when its CSS is safe, dropped whole otherwise.
type pendingStyle struct {
	attrs []xml.Attr
	css   strings.Builder
}

// Rebuilds data as a safe SVG, or refuses it.
func SanitizeSvg(data []byte) ([]byte, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = true
	var w svgWriter
	// The open elements kept (by local name), and whether each one below the root carries an id; skip counts the
	// depth inside a dropped element.
	var open []string
	var openWithId []bool
	uses := 0
	skip := 0
	elements := 0
	rootSeen, rootDone := false, false
	var style *pendingStyle
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if !rootSeen {
				return nil, refuseIcon(IconRefusedType)
			}
			return nil, refuseIcon(IconRefusedUnreadable)
		}
		switch t := tok.(type) {
		case xml.Directive:
			return nil, refuseIcon(IconRefusedSvgDoctype)
		case xml.StartElement:
			if rootDone {
				return nil, refuseIcon(IconRefusedUnreadable)
			}
			elements++
			if elements > maxSvgElements || len(open)+skip >= maxSvgDepth {
				return nil, refuseIcon(IconRefusedUnreadable)
			}
			inSvg := t.Name.Space == "" || t.Name.Space == svgNamespace
			if !rootSeen {
				if !inSvg || t.Name.Local != "svg" {
					return nil, refuseIcon(IconRefusedType)
				}
				rootSeen = true
			}
			if skip > 0 || style != nil || !inSvg || !svgAllowedElements[t.Name.Local] {
				skip++
				continue
			}
			// A <use> inside an element another <use> can point at multiplies at each level (a "billion laughs" of
			// instances when the browser renders it): <use> is kept only outside every element with an id.
			if t.Name.Local == "use" {
				uses++
				if uses > maxSvgUses || slices.Contains(openWithId, true) {
					skip++
					continue
				}
			}
			attrs := keepSvgAttrs(t.Name.Local, t.Attr, len(open) == 0)
			if t.Name.Local == "style" {
				style = &pendingStyle{attrs: attrs}
				continue
			}
			w.start(t.Name.Local, attrs, len(open) == 0)
			if len(open) > 0 {
				openWithId = append(openWithId, slices.ContainsFunc(attrs, func(a xml.Attr) bool { return a.Name.Local == "id" }))
			}
			open = append(open, t.Name.Local)
		case xml.EndElement:
			if skip > 0 {
				skip--
				continue
			}
			if style != nil {
				if css := style.css.String(); safeSvgCss(css) {
					w.start("style", style.attrs, false)
					w.escaped(css)
					w.end("style")
				}
				style = nil
				continue
			}
			if len(open) == 0 {
				continue
			}
			w.end(open[len(open)-1])
			open = open[:len(open)-1]
			if len(open) > 0 {
				openWithId = openWithId[:len(open)-1]
			}
			if len(open) == 0 {
				rootDone = true
			}
		case xml.CharData:
			if skip > 0 {
				continue
			}
			if style != nil {
				style.css.Write(t)
				continue
			}
			if len(open) > 0 && svgTextElements[open[len(open)-1]] {
				w.escaped(string(t))
			}
		}
	}
	if !rootDone {
		if !rootSeen {
			return nil, refuseIcon(IconRefusedType)
		}
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	return w.out.Bytes(), nil
}
