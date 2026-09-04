# Local Production Deployment

The agent is outbound-only and is intended to run on a trusted HomeLab host. HTTPS is recommended; private-LAN HTTP requires explicit acknowledgement.

## Native systemd installation

Create a root-readable key file so the secret does not appear in shell history or the process list:

```bash
sudo install -d -m 700 /root/homelab-agent-install
sudo sh -c 'umask 077; printf "%s\n" "hl_REPLACE_ME" > /root/homelab-agent-install/key'
sudo ./install.sh --dashboard-url https://homelab.home.arpa/api \
  --api-key-file /root/homelab-agent-install/key
```

For a firewall-restricted LAN that intentionally uses HTTP:

```bash
sudo ./install.sh --dashboard-url http://192.168.1.31:3000/api \
  --api-key-file /root/homelab-agent-install/key \
  --allow-insecure-http
```

Without `--allow-insecure-http` (or `ALLOW_INSECURE_HTTP=true`), the agent refuses to send its key over non-loopback HTTP.

The installer copies the key to `/etc/homelab-agent/agent-api-key` with mode 0600. The running agent re-reads this file for every request, so replacing it activates a rotated key without restarting. Pending alerts are stored atomically under `/var/lib/homelab-agent`.

## Docker installation

```bash
mkdir -p secrets
chmod 700 secrets
printf '%s\n' 'hl_REPLACE_ME' > secrets/agent-api-key
chmod 600 secrets/agent-api-key
cp .env.example .env
docker compose config
docker compose up -d --build
```

The Docker socket grants security-sensitive daemon access even when mounted read-only. Remove that mount if Docker telemetry is unnecessary. For stronger isolation, put an allowlisted Docker socket proxy between the agent and the daemon.

## Verification

```bash
systemctl status homelab-agent
journalctl -u homelab-agent --since '10 minutes ago'
```

- Confirm registration and metric reports succeed.
- Stop the dashboard, trigger an agent event, restart the agent, and confirm the queued event is delivered after the dashboard returns.
- Rotate the key file and confirm the old key is rejected.
- Verify the agent host can reach only the intended dashboard address/port.
