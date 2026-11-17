#!/data/data/com.termux/files/usr/bin/sh
set -eu

termux_root=/data/data/com.termux/files
export PATH="$termux_root/usr/bin:$PATH"
export TMPDIR="$termux_root/usr/tmp"
export PREFIX="$termux_root/usr"
export LD_LIBRARY_PATH="$termux_root/usr/lib"
export PM2_HOME="$termux_root/home/.pm2-eddy"
server_dir="$termux_root/home/eddy/server"
pm2="$termux_root/usr/lib/node_modules/pm2/bin/pm2"

if [ ! -r "$server_dir/ecosystem.config.cjs" ] || [ ! -r "$server_dir/config.local.json" ]; then
  printf '%s\n' 'Falta instalar o servidor Eddy ou a sua configuração local.' >&2
  exit 1
fi

cd "$server_dir"

# Boot and the app watchdog may call this at the same time.
exec 9> "$server_dir/.startup.lock"
flock -x -w 30 9

if curl --fail --silent --max-time 2 http://127.0.0.1:3000/api/health >/dev/null; then
  exit 0
fi

termux-wake-lock >/dev/null 2>&1 || true
node "$pm2" startOrRestart "$server_dir/ecosystem.config.cjs" --only eddy-server --update-env 9>&-
