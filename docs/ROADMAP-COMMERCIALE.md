# AsterPanel — Roadmap di commercializzazione

> Obiettivo: vendere AsterPanel come **alternativa moderna e solida** ai pannelli classici
> (cPanel/WHM, Plesk, DirectAdmin). Documento di lavoro, aggiornato man mano che le fasi vengono completate.

## Principio guida (vincolante)

**Ogni risorsa creabile deve essere modificabile e cancellabile.** "Edit" è parte
obbligatoria di ogni slice (come migration, test e audit). Niente più risorse "usa e getta".

---

## Stato di partenza (già implementato)

Base molto ampia: siti, domini/DNS, DNSSEC, SSL, runtime (PHP/Node, php.ini), app one-click,
applicazioni (git deploy, env, start command), staging, git push-to-deploy, CDN (Cloudflare),
email completa (caselle, alias/forwarder, autoresponder, filtri Sieve, spam/Rspamd, mailing list,
DKIM, coda, track delivery), webmail, database (MySQL/PG, utenti, query runner, schema browser,
accesso remoto, export), file manager, FTP/SFTP, backup (S3, schedule, checksum), web disk,
CalDAV/CardDAV, cron, env/secrets, metriche storiche, health, log, service manager, nodi,
firewall, WAF, security advisor, hotlink, directory privacy, dynamic DNS, audit log, API token,
reseller mono-livello, impersonation, pacchetti/quote, branding white-label, migrazione da cPanel,
webhook, notifiche, SSO (OIDC), i18n, dark mode, mobile.

**Due lacune strutturali rilevate dall'audit del codice:**
1. **Editabilità**: ~20 risorse hanno create+delete ma **non** edit.
2. **Reseller**: schema `organizations.parent_org_id` + `is_reseller` presenti, ma logica **mono-livello** (niente master/alpha reseller).

---

## PARTE 1 — Editabilità completa (retrofit)

Risorse senza edit, da colmare:

- **Email**: casella (password, quota, sospensione), forwarder/alias, filtro Sieve, autoresponder, mailing list
- **DNS**: record DNS (oggi delete+ricrea), record Cloudflare
- **Hosting**: sito (nome, domini, doc root, sospensione), sottodominio, FTP (password/quota/home), redirect, cron
- **DB**: utente DB (rename, password), host remoto
- **Sicurezza**: regola firewall/WAF, chiave SSH, hotlink, dir-privacy, webdav, caldav
- **Integrazioni**: provider SSO (edit + toggle), webhook (edit + toggle), schedule backup

**Approccio**: pattern UI edit riusabile (drawer/inline), endpoint `POST .../{id}`, store `Update*`
con `COALESCE`, + azioni **bulk**. Le risorse con job declarativo (`dns.apply`, `cron.apply`,
`mail.*.apply`, `firewall.apply`, `waf.apply`) hanno l'edit lato agent "gratis" (re-render).

---

## PARTE 2 — Rivenditori multi-livello (master / alpha)

1. **Gerarchia ricorsiva** — sub-account `is_reseller` può creare propri sub-account (N livelli); `IsSubAccountOf` → controllo antenato ricorsivo (`WITH RECURSIVE`). Ruoli: root → master → reseller (alpha) → cliente.
2. **ACL rivenditore** — quali permessi/feature un reseller può delegare ai suoi account (feature list).
3. **Allocazione risorse + overselling** — budget per reseller, ripartito ai suoi account, con ratio overselling e accounting che risale l'albero.
4. **Pacchetti per-reseller** — ogni reseller definisce piani dentro la sua allocazione (`owner_org_id` sui plan).
5. **Branding per-reseller** — nameserver, skin, contatti, dominio pannello (oggi branding globale).
6. **Trasferimento account** tra reseller + **sospensione a cascata** con motivazioni.
7. **Dashboard reseller** — conteggi/limiti, riuso dell'impersonation esistente.

---

## PARTE 3 — Gap commerciali per categoria

- **A. Billing & monetizzazione**: gateway pagamento, fatturazione automatica, dunning, proration, IVA/tasse, signup/order pubblico, moduli WHMCS/Blesta, usage-based.
- **B. Account & provisioning**: edit account completo, sospensione con motivo/policy, template account, welcome email, T&C, operazioni bulk, feature-list granulari.
- **C. Multi-server / scala**: cluster nodi + auto-placement, server groups, DNS clustering, live migration, HA/failover.
- **D. Sicurezza & compliance**: policy 2FA/password, IP allowlist per account, ModSecurity/antimalware, GDPR export/erasure, retention audit, export SIEM.
- **E. Email deliverability**: UI SPF/DKIM/DMARC + PTR, reputation/blacklist monitor, quarantena spam, limiti outbound, smarthost/relay.
- **F. DNS**: template DNS, bulk record, zone clustering/secondari, registrar reale (RDAP per disponibilità subito, registrazione = integrazione registrar).
- **G. Backup / DR**: **UI di restore (manca)**, per-account/per-item, point-in-time, multi-destinazione, retention, test-restore, replica off-site.
- **H. Monitoring & alerting**: uptime monitoring, alert su soglie, status page pubblica, SLA report.
- **I. Developer / ops**: terminale SSH in-browser, gestione container UI, API pubblica completa + OpenAPI + rate-limit + SDK, CLI, provider Terraform.
- **J. Supporto**: ticketing/helpdesk, knowledge base, annunci/MOTD, wizard onboarding.
- **K. Licensing & distribuzione**: license server del prodotto, canale update/patch, installer, matrice OS.
- **L. UX**: ricerca globale, scorciatoie, accessibilità WCAG, RTL + più lingue, help contestuale, app mobile.

---

## PARTE 4 — Roadmap a fasi

| Fase | Obiettivo | Contenuto |
|---|---|---|
| **F1 — Solidità** | Pannello serio/credibile | Editabilità completa · restore backup UI · edit account + policy 2FA/password · azioni bulk |
| **F2 — Rivendita** | Mercato reseller | Reseller multi-tier · pacchetti per-reseller · branding per-reseller · feature-list |
| **F3 — Monetizzazione** | Incassare | Billing/pagamenti · signup/order · dunning/IVA · modulo WHMCS · license server prodotto |
| **F4 — Scala/Enterprise** | Grandi clienti | Cluster multi-server · DNS clustering · HA · deliverability avanzata · compliance/SIEM · API/SDK/Terraform |

**Quick win (alto valore / basso costo):** restore backup UI · edit casella (password/quota) ·
edit record DNS · edit cron · toggle/edit provider SSO & webhook · check dominio RDAP.

---

## Avanzamento

- [ ] F1 — Editabilità completa
- [ ] F1 — Restore backup UI
- [ ] F1 — Edit account + policy sicurezza
- [ ] F2 — Reseller multi-livello
- [ ] F3 — Billing/monetizzazione
- [ ] F4 — Scala/Enterprise
