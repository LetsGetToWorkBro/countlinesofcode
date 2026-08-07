#!/bin/sh
# Stand up the 1999.LOC onion mirror on a fresh Debian or Ubuntu box.
#
#   sudo ./install.sh /path/to/mkp224o-key-dir     # use a vanity key
#   sudo ./install.sh                              # let Tor pick the address
#
# The key directory is the one mkp224o wrote: it holds hs_ed25519_secret_key,
# hs_ed25519_public_key and hostname. Running this twice is safe; it will not
# overwrite a key that is already in place unless you pass a new one.
#
# What this leaves behind: nginx listening on 127.0.0.1:8080 and nothing else,
# tor publishing one onion service in front of it, both enabled at boot.

set -eu

ORIGIN=1999loc.com
SERVICE_DIR=/var/lib/tor/1999loc
HERE=$(cd "$(dirname "$0")" && pwd)
KEYDIR=${1:-}

if [ "$(id -u)" -ne 0 ]; then
	echo "run this as root" >&2
	exit 1
fi

say() { printf '\n=== %s\n' "$1"; }

say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tor nginx-light ca-certificates curl

# Debian's tor package runs as debian-tor; other packagings use plain "tor".
TORUSER=debian-tor
id "$TORUSER" >/dev/null 2>&1 || TORUSER=tor

say "nginx"
install -m 0644 "$HERE/nginx-onion.conf" /etc/nginx/sites-available/1999loc-onion
ln -sf /etc/nginx/sites-available/1999loc-onion /etc/nginx/sites-enabled/1999loc-onion
# The box is not a web server to the public. The stock site listens on
# 0.0.0.0:80 and has no business being here.
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx >/dev/null 2>&1 || true
systemctl reload nginx

say "tor"
mkdir -p /etc/tor/torrc.d
install -m 0644 "$HERE/torrc" /etc/tor/torrc.d/1999loc.conf
if ! grep -q '^%include /etc/tor/torrc.d/' /etc/tor/torrc 2>/dev/null; then
	printf '\n%%include /etc/tor/torrc.d/*.conf\n' >> /etc/tor/torrc
fi

say "key"
mkdir -p "$SERVICE_DIR"
if [ -n "$KEYDIR" ]; then
	for f in hs_ed25519_secret_key hs_ed25519_public_key hostname; do
		if [ ! -f "$KEYDIR/$f" ]; then
			echo "missing $KEYDIR/$f -- is that a mkp224o output directory?" >&2
			exit 1
		fi
	done
	install -m 0600 "$KEYDIR/hs_ed25519_secret_key" "$SERVICE_DIR/"
	install -m 0600 "$KEYDIR/hs_ed25519_public_key" "$SERVICE_DIR/"
	install -m 0600 "$KEYDIR/hostname" "$SERVICE_DIR/"
	echo "installed the key for $(cat "$SERVICE_DIR/hostname")"
elif [ -f "$SERVICE_DIR/hostname" ]; then
	echo "keeping the key already in $SERVICE_DIR"
else
	echo "no key given; tor will generate one on first start"
fi
# Tor refuses to start if anyone but its own user can read this.
chown -R "$TORUSER:$TORUSER" "$SERVICE_DIR"
chmod 700 "$SERVICE_DIR"

say "start"
systemctl enable tor >/dev/null 2>&1 || true
systemctl restart tor

# The descriptor takes a moment to reach the directory hashring.
i=0
while [ ! -f "$SERVICE_DIR/hostname" ] && [ "$i" -lt 30 ]; do
	sleep 1
	i=$((i + 1))
done

if [ ! -f "$SERVICE_DIR/hostname" ]; then
	echo "tor did not write a hostname; check: journalctl -u tor -n 50" >&2
	exit 1
fi

ADDR=$(cat "$SERVICE_DIR/hostname")

say "check"
# Straight at nginx, no Tor involved: does the origin answer and are the two
# headers that must not cross the boundary actually gone?
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $ADDR" http://127.0.0.1:8080/)
echo "origin through nginx: HTTP $CODE"
curl -sI -H "Host: $ADDR" http://127.0.0.1:8080/ \
	| grep -i 'strict-transport-security\|onion-location' \
	&& echo "WARNING: a header that should have been stripped got through" \
	|| echo "hsts and onion-location: stripped, as intended"

cat <<EOF

=== done

  $ADDR

Two things left, neither of them on this box:

  1. Load that address in Tor Browser and click through the tools. The wallet,
     the swap and the disposable inbox all call /api/ paths, and they are the
     part worth checking rather than assuming.

  2. Then, from a checkout of the site, advertise it:

         npm run onion:set $ADDR
         git commit -am "Advertise the onion mirror"
         git push

     Do that step last. Until this service is answering, the header would be
     pointing Tor Browser at a door that is not there.

Back up $SERVICE_DIR/hs_ed25519_secret_key somewhere offline. That file is
the address: lose it and it is gone, leak it and somebody else can be you.
EOF
