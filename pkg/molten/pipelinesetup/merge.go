// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// The proposed file keeps everything the setup does not set up byte for byte (DS-MC-031): only the top-level keys it
// writes (release, versions, branches, steps) are replaced in place, or added before the closing brace.

type keySpan struct {
	start, end int
}

// topLevelSpans finds where each top-level key's value starts and ends in a JSON object.
func topLevelSpans(data []byte) (map[string]keySpan, int, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return nil, 0, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, 0, fmt.Errorf("the file is not a JSON object")
	}
	spans := map[string]keySpan{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, 0, err
		}
		key, ok := tok.(string)
		if !ok {
			return nil, 0, fmt.Errorf("unexpected token %v", tok)
		}
		var raw json.RawMessage
		before := int(dec.InputOffset())
		if err := dec.Decode(&raw); err != nil {
			return nil, 0, err
		}
		end := int(dec.InputOffset())
		start := end - len(raw)
		if start < before {
			start = before
		}
		spans[key] = keySpan{start: start, end: end}
	}
	tok, err = dec.Token()
	if err != nil {
		return nil, 0, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '}' {
		return nil, 0, fmt.Errorf("the file is not a JSON object")
	}
	closing := int(dec.InputOffset()) - 1
	if _, err := dec.Token(); err != io.EOF {
		return nil, 0, fmt.Errorf("the file holds more than one JSON value")
	}
	return spans, closing, nil
}

// indentUnit is the file's indentation, read from its first indented line; four spaces by default.
func indentUnit(data []byte) string {
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimLeft(line, " \t")
		if trimmed != "" && len(trimmed) < len(line) {
			return line[:len(line)-len(trimmed)]
		}
	}
	return "    "
}

// A value whose one-line form fits stays on one line, as the pipelines written by hand do (a version file, a job).
const inlineWidth = 100

func encodeValue(value any, unit string) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	// Read back keeping the keys in the struct's order.
	ordered, err := orderedTree(encoded)
	if err != nil {
		return nil, err
	}
	var out strings.Builder
	writePretty(&out, ordered, unit, 1)
	return []byte(out.String()), nil
}

func mustEncode(value any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.Encode(value)
	return b.Bytes()
}

type orderedObject struct {
	keys   []string
	values []any
}

// orderedTree reads JSON keeping the objects' key order.
func orderedTree(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return readOrdered(dec)
}

func readOrdered(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return tok, nil
	}
	switch delim {
	case '{':
		obj := &orderedObject{}
		for dec.More() {
			key, err := dec.Token()
			if err != nil {
				return nil, err
			}
			value, err := readOrdered(dec)
			if err != nil {
				return nil, err
			}
			obj.keys = append(obj.keys, key.(string))
			obj.values = append(obj.values, value)
		}
		_, err := dec.Token()
		return obj, err
	case '[':
		list := []any{}
		for dec.More() {
			value, err := readOrdered(dec)
			if err != nil {
				return nil, err
			}
			list = append(list, value)
		}
		_, err := dec.Token()
		return list, err
	}
	return nil, fmt.Errorf("unexpected %v", delim)
}

func scalarText(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return string(bytes.TrimSpace(mustEncode(x)))
	case bool:
		if x {
			return "true"
		}
		return "false"
	case json.Number:
		return x.String()
	}
	return fmt.Sprint(v)
}

// inline is the value on one line, `{ "a": 1 }` and `["x"]` as the hand-written pipelines put them.
func inline(v any) string {
	switch x := v.(type) {
	case *orderedObject:
		if len(x.keys) == 0 {
			return "{}"
		}
		parts := make([]string, len(x.keys))
		for i, k := range x.keys {
			parts[i] = scalarText(k) + ": " + inline(x.values[i])
		}
		return "{ " + strings.Join(parts, ", ") + " }"
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			parts[i] = inline(item)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	}
	return scalarText(v)
}

func writePretty(out *strings.Builder, v any, unit string, depth int) {
	one := inline(v)
	if len(one)+len(unit)*depth <= inlineWidth {
		out.WriteString(one)
		return
	}
	pad := strings.Repeat(unit, depth)
	switch x := v.(type) {
	case *orderedObject:
		out.WriteString("{\n")
		for i, k := range x.keys {
			out.WriteString(pad + unit + scalarText(k) + ": ")
			writePretty(out, x.values[i], unit, depth+1)
			if i < len(x.keys)-1 {
				out.WriteString(",")
			}
			out.WriteString("\n")
		}
		out.WriteString(pad + "}")
	case []any:
		out.WriteString("[\n")
		for i, item := range x {
			out.WriteString(pad + unit)
			writePretty(out, item, unit, depth+1)
			if i < len(x)-1 {
				out.WriteString(",")
			}
			out.WriteString("\n")
		}
		out.WriteString(pad + "]")
	default:
		out.WriteString(one)
	}
}

type keyValue struct {
	Key   string
	Value any
}

// verbatim is a value's text already laid out at the top level's depth: MergeTopLevel writes it as it is.
type verbatim []byte

func encodeTopLevel(value any, unit string) ([]byte, error) {
	if text, ok := value.(verbatim); ok {
		return text, nil
	}
	return encodeValue(value, unit)
}

// MergeTopLevel replaces or adds the top-level keys in the file's text; a nil value leaves its key as it is. Without a
// file, it writes a new one with the base keys first.
func MergeTopLevel(current []byte, base []keyValue, values []keyValue) ([]byte, error) {
	if len(bytes.TrimSpace(current)) == 0 {
		unit := "    "
		var b strings.Builder
		b.WriteString("{\n")
		all := append(append([]keyValue{}, base...), values...)
		first := true
		for _, kv := range all {
			if kv.Value == nil {
				continue
			}
			encoded, err := encodeTopLevel(kv.Value, unit)
			if err != nil {
				return nil, err
			}
			if !first {
				b.WriteString(",\n")
			}
			first = false
			fmt.Fprintf(&b, "%s%q: %s", unit, kv.Key, encoded)
		}
		b.WriteString("\n}\n")
		return []byte(b.String()), nil
	}
	out := append([]byte(nil), current...)
	unit := indentUnit(current)
	for _, kv := range values {
		if kv.Value == nil {
			continue
		}
		spans, closing, err := topLevelSpans(out)
		if err != nil {
			return nil, err
		}
		encoded, err := encodeTopLevel(kv.Value, unit)
		if err != nil {
			return nil, err
		}
		if span, ok := spans[kv.Key]; ok {
			out = append(append(append([]byte(nil), out[:span.start]...), encoded...), out[span.end:]...)
			continue
		}
		// Added after the last value, keeping the closing brace's line.
		at := closing
		for at > 0 && (out[at-1] == ' ' || out[at-1] == '\t' || out[at-1] == '\n' || out[at-1] == '\r') {
			at--
		}
		sep := ","
		if len(spans) == 0 {
			sep = ""
		}
		insert := fmt.Sprintf("%s\n%s%q: %s", sep, unit, kv.Key, encoded)
		out = append(append(append([]byte(nil), out[:at]...), insert...), out[at:]...)
	}
	return out, nil
}
