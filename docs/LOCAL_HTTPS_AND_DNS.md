# Local HTTPS and DNS

OptiLens Local is available at `https://optilens.cv.net/` on the LAN. The IIS and
Technitium DNS host is `192.168.254.7`.

The host runs Technitium DNS and answers `optilens.cv.net` as `192.168.254.7`. It forwards normal internet DNS resolution. Its administration console is intentionally local-only at `http://127.0.0.1:5380/`.

## Addresses, routes, and host paths

| Purpose | Address or path |
| --- | --- |
| OptiLens LAN URL | `https://optilens.cv.net/` |
| IIS host and Technitium DNS server | `192.168.254.7` |
| DNS server (clients / DHCP option) | `192.168.254.7` on port `53` |
| DNS administration console (host only) | `http://127.0.0.1:5380/` |
| Node application (host only; IIS proxy target) | `http://127.0.0.1:8080/` |
| Public root certificate for LAN clients | `data/certificates/OptiLens-Local-Root-CA.cer` |
| HTTPS certificate management script | `scripts/manage-local-https.ps1` |
| IIS reverse-proxy template | `templates/iis-optilens-web.config` |
| Technitium service data | `C:\ProgramData\Technitium DNS Server` |
| Technitium authentication file | `C:\ProgramData\Technitium DNS Server\auth.config` |

Do not put the DNS-console password, API tokens, or certificate private keys in this repository or browser JavaScript.

## Connecting a workstation

Until the router's DHCP configuration is updated, configure one workstation at a time:

1. Set that workstation's primary DNS server to `192.168.254.7`. Keep the existing router DNS server as secondary while testing.
2. Install `data/certificates/OptiLens-Local-Root-CA.cer` into **Local Computer → Trusted Root Certification Authorities**. The file contains only the public root certificate.
3. Browse to `https://optilens.cv.net/` and confirm the browser reports a trusted certificate.

Do not enable Technitium's DHCP service: the existing router remains the DHCP authority. When the router is ready, configure its DHCP scope to provide `192.168.254.7` as the primary DNS server for the LAN.

## Host administration

Use the **HTTPS & DNS** tab of OptiLens Local Host Monitor to see certificate expiry, open the local DNS console, open the public root-certificate folder, and renew the server certificate. The CA private key is non-exportable and remains in the host's Local Machine certificate store.

The scripted status/renewal interface is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/manage-local-https.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/manage-local-https.ps1 -Action RenewServerCertificate
```

### DNS record maintenance

In the DNS console, open the `optilens.cv.net` primary zone. The apex `A` record
must remain `192.168.254.7` with the comment `OptiLens Local LAN HTTPS endpoint`.
The normal TTL is 300 seconds. Do not change the `NS` or `SOA` records when only
the web-host address needs correcting.

Verify authoritative resolution from the host:

```powershell
Resolve-DnsName -Name optilens.cv.net -Type A -Server 127.0.0.1 -DnsOnly
Test-NetConnection -ComputerName 192.168.254.7 -Port 443
```

### DNS administrator password recovery

Use this only from the IIS/DNS host and only when the administrator password is
unavailable. It resets the `admin` user to the Technitium default credentials and
disables that user's 2FA. Stop the **Technitium DNS Server** (`DnsService`), rename
`C:\ProgramData\Technitium DNS Server\auth.config` to `resetadmin.config`, start the
service, sign in at `http://127.0.0.1:5380/`, and immediately set a new strong
password. The renamed file is retained as a recovery backup; it must not be copied
into this repository.

The service can be managed through `services.msc` or these elevated PowerShell
commands:

```powershell
Stop-Service -Name DnsService
Rename-Item 'C:\ProgramData\Technitium DNS Server\auth.config' 'resetadmin.config'
Start-Service -Name DnsService
```

## Network boundaries

- IIS terminates TLS on port 443 and proxies to the Node service at `127.0.0.1:8080`.
- Port 80 only redirects to HTTPS.
- LAN traffic cannot directly reach Node port 8080.
- DNS access is allowed from `192.168.254.0/24` only.

If the local DNS server must be temporarily bypassed, restore the workstation/router DNS settings to their previous resolver. The LAN HTTPS site will still work for machines that retain a hosts/DNS mapping and the OptiLens root certificate.
