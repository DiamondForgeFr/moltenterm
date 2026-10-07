# Source the original zlogin
[ -f ~/.zlogin ] && source ~/.zlogin

# MOLTENTERM-PATCH (#318): ~/.zlogin runs after ~/.zshrc in a login shell; keep the agent launchers first on PATH
if (( $+functions[_moltenterm_agentpath] )); then
  _moltenterm_agentpath
fi

# Unset ZDOTDIR only if it hasn't been modified
if [ "$ZDOTDIR" = "$WAVETERM_ZDOTDIR" ]; then
  unset ZDOTDIR
fi