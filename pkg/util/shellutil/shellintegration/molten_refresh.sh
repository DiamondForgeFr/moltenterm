# MoltenTerm's managed shell environment, generation {{.GEN}} (FR-SHELL-041, DS-SHELL-074). MoltenTerm rewrites this
# file at every start; its zsh and bash integration sources it before each prompt and each command, so a shell left
# open across an update catches up. It only acts where the agent launchers' folder exists (never on a remote host).
_moltenterm_rdir={{.AGENTBINDIR}}
if [ -d "$_moltenterm_rdir" ]; then
  _moltenterm_rmiss=
  if [[ ":$PATH:" != *":$_moltenterm_rdir:"* ]]; then
    _moltenterm_rmiss=1
  fi
  if [ "${_MOLTENTERM_SHELLGEN:-0}" != {{.GEN}} ] || [ -n "$_moltenterm_rmiss" ]; then
    export MOLTENTERM_AGENTBINDIR="$_moltenterm_rdir"
    _moltenterm_rrest=":$PATH:"
    while [[ "$_moltenterm_rrest" == *":$_moltenterm_rdir:"* ]]; do
      _moltenterm_rrest="${_moltenterm_rrest//":$_moltenterm_rdir:"/:}"
    done
    _moltenterm_rrest="${_moltenterm_rrest#:}"
    _moltenterm_rrest="${_moltenterm_rrest%:}"
    export PATH="$_moltenterm_rdir${_moltenterm_rrest:+:$_moltenterm_rrest}"
    if [ "${_MOLTENTERM_SHELLGEN:-0}" != {{.GEN}} ]; then
      _MOLTENTERM_SHELLGEN={{.GEN}}
      if [[ -z "${TMUX:-}" && -z "${STY:-}" && "${TERM:-}" != tmux* && "${TERM:-}" != screen* ]]; then
        printf '\033]16162;MOLTEN;{"gen":%d}\007' {{.GEN}}
      fi
    fi
  fi
fi
unset _moltenterm_rdir _moltenterm_rmiss _moltenterm_rrest
