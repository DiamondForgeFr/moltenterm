#!/bin/bash
# Moltenterm's deb post-install script (Wave's template targets /opt/Wave and /usr/bin/waveterm).

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/moltenterm' -a -e '/usr/bin/moltenterm' -a "`readlink '/usr/bin/moltenterm'`" != '/etc/alternatives/moltenterm' ]; then
        rm -f '/usr/bin/moltenterm'
    fi
    update-alternatives --install '/usr/bin/moltenterm' 'moltenterm' '/opt/Moltenterm/moltenterm' 100 || ln -sf '/opt/Moltenterm/moltenterm' '/usr/bin/moltenterm'
else
    ln -sf '/opt/Moltenterm/moltenterm' '/usr/bin/moltenterm'
fi

chmod 4755 '/opt/Moltenterm/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
