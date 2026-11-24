// Generate the Linux portable launcher wrapper, user-level installer/uninstaller,
// XDG .desktop entry and optional AppArmor profile for Ubuntu 24.04+ kernels.

export const APP_ID = 'grokbot-local';
export const APP_NAME = 'Grok Bot Local';

export function launcherScript() {
  return `#!/usr/bin/env sh
set -eu

SELF=$0
while [ -L "$SELF" ]; do
  TARGET=$(readlink "$SELF")
  case "$TARGET" in
    /*) SELF=$TARGET ;;
    *) SELF=$(dirname "$SELF")/$TARGET ;;
  esac
done
APP_DIR=$(CDPATH= cd -- "$(dirname "$SELF")" && pwd)
BIN="$APP_DIR/grok-bot"
SANDBOX="$APP_DIR/chrome-sandbox"

has_no_sandbox=0
for arg in "$@"; do
  if [ "$arg" = "--no-sandbox" ]; then
    has_no_sandbox=1
    break
  fi
done

if [ "\${GROKBOT_NO_SANDBOX:-0}" = "1" ] && [ "$has_no_sandbox" -eq 0 ]; then
  exec "$BIN" --class=${APP_ID} --no-sandbox "$@"
fi

if [ "$has_no_sandbox" -eq 0 ] && [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && \
   [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  suid_ok=0
  if [ -u "$SANDBOX" ] && [ "$(stat -c '%u' "$SANDBOX" 2>/dev/null || echo 1)" = "0" ]; then
    suid_ok=1
  fi
  profile_ok=0
  if [ -r /sys/kernel/security/apparmor/profiles ] && grep -q '^${APP_ID} ' /sys/kernel/security/apparmor/profiles 2>/dev/null; then
    profile_ok=1
  fi
  if [ "$suid_ok" -eq 0 ] && [ "$profile_ok" -eq 0 ]; then
    cat >&2 <<EOF
[grokbot-local] This kernel restricts unprivileged user namespaces (AppArmor).
If Electron aborts on sandbox startup, choose one of:
  1. Recommended: install the AppArmor profile once:
     sudo "$APP_DIR/setup-apparmor.sh"
  2. Temporary fallback without Chromium sandbox:
     GROKBOT_NO_SANDBOX=1 "$APP_DIR/${APP_ID}"
EOF
  fi
fi

exec "$BIN" --class=${APP_ID} "$@"
`;
}

export function apparmorProfile(binaryPath) {
  return `abi <abi/4.0>,
include <tunables/global>

profile "${APP_ID}" "${binaryPath}" flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/${APP_ID}>
}
`;
}

export function setupAppArmorScript() {
  return `#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

APP_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
BIN="$APP_DIR/grok-bot"
TARGET="/etc/apparmor.d/${APP_ID}"

if [ ! -x "$BIN" ]; then
  echo "Missing binary: $BIN" >&2
  exit 1
fi

cat > "$TARGET" <<EOF
abi <abi/4.0>,
include <tunables/global>

profile "${APP_ID}" "$BIN" flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/${APP_ID}>
}
EOF

if command -v apparmor_parser >/dev/null 2>&1; then
  apparmor_parser --replace --write-cache --skip-read-cache "$TARGET"
  echo "Installed and loaded AppArmor profile: $TARGET"
else
  echo "Wrote $TARGET (apparmor_parser not found; reload AppArmor manually)."
fi
`;
}

export function desktopEntry(execPath) {
  const escaped = execPath.replace(/([\\"$`])/g, '\\$1');
  const quoted = /\s/.test(execPath) ? `"${escaped}"` : execPath;
  return `[Desktop Entry]
Name=${APP_NAME}
Comment=Self-hosted Grok Bot desktop client
Exec=${quoted} %U
Terminal=false
Type=Application
Icon=${APP_ID}
StartupWMClass=${APP_ID}
MimeType=x-scheme-handler/${APP_ID};
Categories=Development;Network;
`;
}

export function installScript() {
  return `#!/usr/bin/env sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
DATA_HOME="\${XDG_DATA_HOME:-$HOME/.local/share}"
INSTALL_DIR="$DATA_HOME/${APP_ID}"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/512x512/apps"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      shift
      [ "$#" -gt 0 ] || { echo "Missing value for --dir" >&2; exit 2; }
      INSTALL_DIR=$1
      ;;
    --bin-dir)
      shift
      [ "$#" -gt 0 ] || { echo "Missing value for --bin-dir" >&2; exit 2; }
      BIN_DIR=$1
      ;;
    --help|-h)
      cat <<EOF
Usage: sh install.sh [--dir <install-dir>] [--bin-dir <bin-dir>]
Installs ${APP_NAME} for the current user (no root required).
Defaults:
  --dir     $DATA_HOME/${APP_ID}
  --bin-dir $HOME/.local/bin
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ ! -x "$SOURCE_DIR/grok-bot" ] || [ ! -f "$SOURCE_DIR/resources/app.asar" ]; then
  echo "Run install.sh from the extracted ${APP_ID} directory." >&2
  exit 1
fi

case "$INSTALL_DIR" in
  *" "*|*"	"*)
    echo "Warning: install directory contains spaces; avoid spaces if using SUID chrome-sandbox." >&2
    ;;
esac

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR" "$APP_DIR" "$ICON_DIR"

SRC_REAL=$(CDPATH= cd -- "$SOURCE_DIR" && pwd -P)
DST_PARENT=$(CDPATH= cd -- "$(dirname "$INSTALL_DIR")" && pwd -P)
DST_REAL="$DST_PARENT/$(basename "$INSTALL_DIR")"

# Replace or remove only an empty directory or an earlier ${APP_NAME} install.
own_install() {
  [ -f "$1/resources/grokbot-local.patch.json" ] && [ -f "$1/grok-bot" ]
}

if [ "$SRC_REAL" != "$DST_REAL" ] && [ -e "$DST_REAL" ] && ! own_install "$DST_REAL" && [ -n "$(ls -A "$DST_REAL" 2>/dev/null)" ]; then
  echo "Refusing to replace $DST_REAL: it is not a ${APP_NAME} install. Choose an empty or new directory with --dir." >&2
  exit 1
fi

if [ "$SRC_REAL" != "$DST_REAL" ]; then
  STAGE="$DST_PARENT/.${APP_ID}-install-$$"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  cp -a "$SOURCE_DIR/." "$STAGE/"
  rm -rf "$DST_REAL"
  mv "$STAGE" "$DST_REAL"
fi

chmod 0755 "$DST_REAL/${APP_ID}" "$DST_REAL/grok-bot" "$DST_REAL/install.sh" "$DST_REAL/uninstall.sh" "$DST_REAL/setup-apparmor.sh"
chmod 0755 "$DST_REAL/resources/grokbot-tailcat"
ln -sf "$DST_REAL/${APP_ID}" "$BIN_DIR/${APP_ID}"

if [ -f "$DST_REAL/resources/icon.png" ]; then
  cp -f "$DST_REAL/resources/icon.png" "$ICON_DIR/${APP_ID}.png"
fi

EXEC_LINE="$DST_REAL/${APP_ID}"
case "$EXEC_LINE" in
  *" "*|*"	"*) EXEC_LINE="\\"$EXEC_LINE\\"" ;;
esac

cat > "$APP_DIR/${APP_ID}.desktop" <<EOF
[Desktop Entry]
Name=${APP_NAME}
Comment=Self-hosted Grok Bot desktop client
Exec=$EXEC_LINE %U
Terminal=false
Type=Application
Icon=${APP_ID}
StartupWMClass=${APP_ID}
MimeType=x-scheme-handler/${APP_ID};
Categories=Development;Network;
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi
if command -v xdg-mime >/dev/null 2>&1; then
  xdg-mime default "${APP_ID}.desktop" "x-scheme-handler/${APP_ID}" >/dev/null 2>&1 || true
fi

echo "Installed ${APP_NAME} to: $DST_REAL"
echo "Launcher symlink: $BIN_DIR/${APP_ID}"
echo "Desktop entry: $APP_DIR/${APP_ID}.desktop"

if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && \
   [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  echo ""
  echo "Ubuntu/AppArmor userns restriction detected. To keep Chromium sandboxing enabled, run once:"
  echo "  sudo \\"$DST_REAL/setup-apparmor.sh\\""
fi
`;
}

export function uninstallScript() {
  return `#!/usr/bin/env sh
set -eu

DATA_HOME="\${XDG_DATA_HOME:-$HOME/.local/share}"
INSTALL_DIR="$DATA_HOME/${APP_ID}"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$DATA_HOME/applications"
ICON_FILE="$DATA_HOME/icons/hicolor/512x512/apps/${APP_ID}.png"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      shift
      [ "$#" -gt 0 ] || { echo "Missing value for --dir" >&2; exit 2; }
      INSTALL_DIR=$1
      ;;
    --bin-dir)
      shift
      [ "$#" -gt 0 ] || { echo "Missing value for --bin-dir" >&2; exit 2; }
      BIN_DIR=$1
      ;;
    --help|-h)
      echo "Usage: sh uninstall.sh [--dir <install-dir>] [--bin-dir <bin-dir>]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# Replace or remove only an empty directory or an earlier ${APP_NAME} install.
own_install() {
  [ -f "$1/resources/grokbot-local.patch.json" ] && [ -f "$1/grok-bot" ]
}

if [ -e "$INSTALL_DIR" ] && ! own_install "$INSTALL_DIR"; then
  echo "Refusing to remove $INSTALL_DIR: it is not a ${APP_NAME} install." >&2
  exit 1
fi

if [ -L "$BIN_DIR/${APP_ID}" ]; then rm -f "$BIN_DIR/${APP_ID}"; fi
rm -f "$APP_DIR/${APP_ID}.desktop" "$ICON_FILE"
rm -rf "$INSTALL_DIR"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "Removed ${APP_NAME} from $INSTALL_DIR."
echo "User settings and credentials in \${XDG_CONFIG_HOME:-$HOME/.config}/${APP_NAME} were kept."
`;
}
