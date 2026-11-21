// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// How each agent's transcript holds a pasted image (#2455). The placeholder the user sees in a message is
// "[Image #N]"; each adapter says which image of the transcript N is.

var imagePlaceholderRegex = regexp.MustCompile(`\[Image #(\d{1,7})\]`)

var (
	// Claude Code writes an image as a base64 block of the user's message; imagePasteIds numbers the message's images
	// as the placeholders do. When the image came from a file, a following meta record says its source.
	claudeImageMarkers     = [][]byte{[]byte(`"imagePasteIds"`), []byte(`"type":"image"`), []byte(`[Image: source:`)}
	claudeImageSourceRegex = regexp.MustCompile(`^\[Image: source: (.+)\]$`)
)

func atoiSafe(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

func containsAny(line []byte, markers [][]byte) bool {
	for _, marker := range markers {
		if bytes.Contains(line, marker) {
			return true
		}
	}
	return false
}

// dataURLBase64 is the base64 text of an image data URL.
func dataURLBase64(url string) (string, bool) {
	if !strings.HasPrefix(url, "data:image/") {
		return "", false
	}
	_, rest, ok := strings.Cut(url, ";base64,")
	if !ok || rest == "" {
		return "", false
	}
	return rest, true
}

// claudePasteIds reads a record's imagePasteIds, the numbers of the placeholders of its images in order.
func claudePasteIds(rec map[string]any) []int {
	var rtn []int
	for _, v := range arr(rec, "imagePasteIds") {
		if f, ok := v.(float64); ok && f >= 1 && f <= imageMaxN {
			rtn = append(rtn, int(f))
		} else {
			rtn = append(rtn, 0)
		}
	}
	return rtn
}

// claudeImageSources reads the paths of a meta record's "[Image: source: <path>]" blocks, in order.
func claudeImageSources(msg map[string]any) []string {
	var rtn []string
	for _, item := range arr(msg, "content") {
		block := asObj(item)
		if str(block, "type") != "text" {
			continue
		}
		if m := claudeImageSourceRegex.FindStringSubmatch(strings.TrimSpace(str(block, "text"))); m != nil {
			rtn = append(rtn, m[1])
		}
	}
	return rtn
}

// FindImages: the user record whose imagePasteIds holds n, and in it the image block at the same index. The meta
// record that follows it (its parentUuid is the record's uuid) names the file each image came from: the image of a
// record whose block is gone, or unreadable, is read from there. A record without imagePasteIds, written by an older
// Claude Code, gives its nth image block when the window knows the message's time.
func (a *ClaudeAdapter) FindImages(path string, n int, at int64) ([]imageCandidate, error) {
	type found struct {
		uuid  string
		index int
		c     imageCandidate
	}
	var founds []found
	sources := map[string][]string{}
	err := scanTranscript(path, func(line []byte) bool {
		if !containsAny(line, claudeImageMarkers) {
			return true
		}
		var rec map[string]any
		if json.Unmarshal(line, &rec) != nil || str(rec, "type") != "user" || boolean(rec, "isSidechain") {
			return true
		}
		msg := obj(rec, "message")
		if boolean(rec, "isMeta") {
			if paths := claudeImageSources(msg); len(paths) > 0 {
				sources[str(rec, "parentUuid")] = paths
			}
			return true
		}
		var blocks []string
		for _, item := range arr(msg, "content") {
			block := asObj(item)
			if str(block, "type") != "image" {
				continue
			}
			source := obj(block, "source")
			data := ""
			if str(source, "type") == "base64" {
				data = str(source, "data")
			}
			blocks = append(blocks, data)
		}
		when := parseTime(str(rec, "timestamp"))
		ids := claudePasteIds(rec)
		index := -1
		for i, id := range ids {
			if id == n {
				index = i
				break
			}
		}
		if index < 0 && len(ids) == 0 && len(blocks) >= n && at > 0 && when == at {
			index = n - 1
		}
		if index < 0 {
			return true
		}
		c := imageCandidate{at: when}
		if index < len(blocks) {
			c.b64 = blocks[index]
		}
		founds = append(founds, found{uuid: str(rec, "uuid"), index: index, c: c})
		return true
	})
	if err != nil {
		return nil, err
	}
	var rtn []imageCandidate
	for _, f := range founds {
		if paths := sources[f.uuid]; f.index < len(paths) {
			f.c.path = paths[f.index]
		}
		if f.c.b64 != "" || f.c.path != "" {
			rtn = append(rtn, f.c)
		}
	}
	return rtn, nil
}

// FindImages: Codex records an image inline, as an input_image of the model's copy of the user message, whose text
// before it names it ("<image name=[Image #N]>"), or as the image or local_image entry of the user message item, which
// come in the order of the message's placeholders. A local image is a path the rollout records.
func (a *CodexAdapter) FindImages(path string, n int, at int64) ([]imageCandidate, error) {
	marker := []byte("[Image #" + strconv.Itoa(n) + "]")
	var rtn []imageCandidate
	err := scanTranscript(path, func(line []byte) bool {
		if !bytes.Contains(line, marker) {
			return true
		}
		var rec map[string]any
		if json.Unmarshal(line, &rec) != nil {
			return true
		}
		when := parseTime(str(rec, "timestamp"))
		payload := obj(rec, "payload")
		var images []imageCandidate
		var labels []int
		switch str(rec, "type") {
		case "response_item":
			images, labels = codexModelImages(payload)
		case "event_msg":
			images, labels = codexEventImages(payload)
		}
		for i, label := range labels {
			if label == n && i < len(images) {
				c := images[i]
				c.at = when
				rtn = append(rtn, c)
			}
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	return rtn, nil
}

func codexImageValue(block map[string]any) string {
	if s := str(block, "image_url"); s != "" {
		return s
	}
	return str(obj(block, "image_url"), "url")
}

// codexModelImages: the images of a user message as the model got it, each with the number its opening text names.
func codexModelImages(payload map[string]any) ([]imageCandidate, []int) {
	if str(payload, "type") != "message" || str(payload, "role") != "user" {
		return nil, nil
	}
	var images []imageCandidate
	var labels []int
	label := 0
	for _, item := range arr(payload, "content") {
		block := asObj(item)
		switch str(block, "type") {
		case "input_text", "text":
			if text := str(block, "text"); strings.Contains(text, "<image") {
				if numbers := imageNumbers(text); len(numbers) > 0 {
					label = numbers[0]
				}
			}
		case "input_image":
			c := imageCandidate{}
			if b64, ok := dataURLBase64(codexImageValue(block)); ok {
				c.b64 = b64
			}
			images = append(images, c)
			labels = append(labels, label)
			label = 0
		}
	}
	return images, labels
}

// codexEventImages: the images of a user message event, paired with the placeholders of its text in order.
func codexEventImages(payload map[string]any) ([]imageCandidate, []int) {
	var text strings.Builder
	var images []imageCandidate
	switch str(payload, "type") {
	case "user_message":
		text.WriteString(str(payload, "message"))
		var paths []any
		if v, ok := payload["local_images"].([]any); ok {
			paths = v
		}
		for _, p := range paths {
			if s, ok := p.(string); ok {
				images = append(images, imageCandidate{path: s})
			}
		}
		if len(images) == 0 {
			if urls, ok := payload["images"].([]any); ok {
				for _, u := range urls {
					s, _ := u.(string)
					c := imageCandidate{}
					if b64, ok := dataURLBase64(s); ok {
						c.b64 = b64
					}
					images = append(images, c)
				}
			}
		}
	case "item_completed":
		item := obj(payload, "item")
		if str(item, "type") != "UserMessage" {
			return nil, nil
		}
		for _, entry := range arr(item, "content") {
			block := asObj(entry)
			switch str(block, "type") {
			case "text", "input_text":
				text.WriteString(str(block, "text"))
				text.WriteString("\n")
			case "image", "input_image":
				c := imageCandidate{}
				if b64, ok := dataURLBase64(codexImageValue(block)); ok {
					c.b64 = b64
				}
				images = append(images, c)
			case "local_image":
				images = append(images, imageCandidate{path: str(block, "path")})
			}
		}
	}
	return images, imageNumbers(text.String())
}

// kimiPromptText is the user's text of a Kimi Code message with "[Image #N]" where it holds an image. Kimi's own
// placeholder is gone from the wire record (an image_url part stands in its place), so the companion numbers the
// session's images in order, and FindImages counts them the same way.
func kimiPromptText(content any, images *int) string {
	items, ok := content.([]any)
	if !ok {
		return kimiContentText(content)
	}
	var parts []string
	for _, item := range items {
		part := asObj(item)
		switch str(part, "type") {
		case "text":
			parts = append(parts, str(part, "text"))
		case "image_url":
			*images++
			parts = append(parts, fmt.Sprintf("[Image #%d]", *images))
		}
	}
	return strings.Join(parts, "\n")
}

func kimiImageURL(part map[string]any) string {
	if url := str(obj(part, "imageUrl"), "url"); url != "" {
		return url
	}
	return str(obj(part, "image_url"), "url")
}

var kimiImageMarkers = [][]byte{[]byte(`"image_url"`), []byte(`"imageUrl"`)}

// FindImages: the nth image of the user's messages, counted in the order the session holds them. Only a data URL is an
// image here; a kimi-file:// reference names a file in the daemon's own storage, which is not read. A transcript
// larger than the companion reads whole was followed from its tail, so its numbers do not match: no image is given.
func (a *KimiAdapter) FindImages(path string, n int, at int64) ([]imageCandidate, error) {
	if info, err := os.Stat(path); err != nil || info.Size() > tailFullReadMax {
		return nil, nil
	}
	count := 0
	var rtn []imageCandidate
	err := scanTranscript(path, func(line []byte) bool {
		if len(line) > tailLineMax || !containsAny(line, kimiImageMarkers) {
			return true
		}
		var rec map[string]any
		if json.Unmarshal(line, &rec) != nil || str(rec, "type") != "context.append_message" {
			return true
		}
		msg := obj(rec, "message")
		if str(msg, "role") != "user" || str(obj(msg, "origin"), "kind") != "user" {
			return true
		}
		for _, item := range arr(msg, "content") {
			part := asObj(item)
			if str(part, "type") != "image_url" {
				continue
			}
			count++
			if count != n {
				continue
			}
			if b64, ok := dataURLBase64(kimiImageURL(part)); ok {
				rtn = append(rtn, imageCandidate{at: kimiRecordTime(rec), b64: b64})
			}
			return false
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	return rtn, nil
}
