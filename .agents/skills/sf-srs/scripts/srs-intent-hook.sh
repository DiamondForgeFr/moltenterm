#!/usr/bin/env bash
# SRS intent-detector hook — Claude Code UserPromptSubmit
#
# Reads the user prompt from stdin (Claude Code passes a JSON envelope
# `{ "prompt": "...", ... }`), runs it through `detect-eval-signals
# --classify`, and emits a system-reminder pointing at the `sf-srs` skill
# when the classifier reports a non-trivial requirement-level signal.
#
# Conservative by design — better to under-fire than to spam. The fire
# rule is: signal in {ur, fr, ds, tc, revision} AND confidence != "low".
# The classifier returns `{trivial, none}` for read-only / exploratory
# turns, which always exit silently.
#
# Opt-out paths (any one short-circuits the hook):
#   - SF_DISABLE_SRS_HOOK=1                     (per-shell)
#   - .saasfoundry.json → tools.srs.enabled = false
#   - .saasfoundry.json → tools.srs.intentDetectorEnabled = false
#
# Always exits 0 — UserPromptSubmit is non-blocking. A hard failure
# inside the classifier is logged to stderr (visible in Claude Code's
# hook output) but never blocks the user's turn.

set -euo pipefail

# Early opt-out
[[ "${SF_DISABLE_SRS_HOOK:-}" == "1" ]] && exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFIER="$SCRIPT_DIR/detect-eval-signals.sh"

# Degrade silently if the classifier is missing (skill uninstalled, etc.)
[[ -x "$CLASSIFIER" ]] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Read the hook envelope
ENVELOPE=$(cat)
PROMPT=$(printf '%s' "$ENVELOPE" | jq -r '.prompt // empty' 2>/dev/null || true)
[[ -z "$PROMPT" ]] && exit 0

# Manifest opt-out — only consult the manifest when in a SaaSFoundryAI project
if [[ -f .saasfoundry.json ]]; then
  ENABLED=$(jq -r '
    if .tools.srs.enabled == false then "false"
    elif .tools.srs.intentDetectorEnabled == false then "false"
    else "true"
    end
  ' .saasfoundry.json 2>/dev/null || echo "true")
  [[ "$ENABLED" == "false" ]] && exit 0
fi

# Classify
CLASSIFICATION=$(printf '%s' "$PROMPT" | "$CLASSIFIER" --classify 2>/dev/null || true)
[[ -z "$CLASSIFICATION" ]] && exit 0

SIGNAL=$(printf '%s' "$CLASSIFICATION" | jq -r '.signal // "none"' 2>/dev/null || echo "none")
CONFIDENCE=$(printf '%s' "$CLASSIFICATION" | jq -r '.confidence // "low"' 2>/dev/null || echo "low")
TARGET=$(printf '%s' "$CLASSIFICATION" | jq -r '.target // ""' 2>/dev/null || echo "")

# Fire rule
case "$SIGNAL" in
  ur|fr|ds|tc|revision) ;;
  *) exit 0 ;;
esac
[[ "$CONFIDENCE" == "low" ]] && exit 0

# Emit system-reminder. Stdout from a UserPromptSubmit hook is injected as
# additional context for the next assistant turn.
cat <<EOF
<system-reminder>
SRS intent-detector: classified this prompt as signal=${SIGNAL} (confidence=${CONFIDENCE}, target="${TARGET}").
This looks like a User Requirement / Functional Requirement / Design Spec / Test Case candidate. Before
coding, consider invoking the \`sf-srs\` skill — propose a diff against the current SRS pages and let the
user confirm before implementing. If the prompt is just exploratory or a quick clarification, ignore
this reminder. Disable per-shell with SF_DISABLE_SRS_HOOK=1 or persistently via
\`.saasfoundry.json\` → \`tools.srs.intentDetectorEnabled = false\`.
</system-reminder>
EOF
