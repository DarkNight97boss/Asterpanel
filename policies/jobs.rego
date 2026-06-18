# Job-dispatch policy. Evaluated before the control plane signs and dispatches a
# job to an agent. Enforces a job-type allowlist and tenant binding so a request
# can never produce a job for another tenant or an unknown executor.
package asterpanel.jobs

import rego.v1

# The complete set of job types the control plane is permitted to emit.
allowed_types := {
	"website.create",
	"website.delete",
	"app.deploy",
	"app.rollback",
	"app.start",
	"app.stop",
	"proxy.apply",
	"redirect.apply",
	"protection.apply",
	"cert.issue",
	"dns.apply",
	"dns.dnssec.enable",
	"dns.dnssec.disable",
	"backup.create",
	"backup.restore",
	"database.create",
	"database.delete",
	"database.user.create",
	"database.user.privileges",
	"database.user.delete",
	"database.query",
	"database.access.apply",
	"database.dump",
	"mail.mailbox.create",
	"mail.server.ensure",
	"mail.dkim.generate",
	"mail.alias.apply",
	"mail.autoresponder.apply",
	"mail.filter.apply",
	"mail.spam.apply",
	"caldav.ensure",
	"caldav.user.apply",
	"cron.apply",
	"ftp.account.create",
	"cert.install",
	"firewall.apply",
	"waf.apply",
	"file.list",
	"file.read",
	"file.write",
	"file.delete",
	"file.mkdir",
	"runtime.switch",
	"runtime.phpini.apply",
	"logs.tail",
	"antivirus.scan",
	"health.check",
	"analytics.compute",
	"service.control",
}

default allow := false

# Superadmins may dispatch any known job type.
allow if {
	input.subject.superadmin == true
	input.job_type in allowed_types
}

# Otherwise: known type AND the job targets the subject's own tenant.
allow if {
	input.job_type in allowed_types
	input.tenant_id == input.subject.org_id
}

reasons contains msg if {
	not input.job_type in allowed_types
	msg := sprintf("unknown job type %q", [input.job_type])
}

reasons contains "job tenant does not match subject organization" if {
	input.tenant_id != input.subject.org_id
	not input.subject.superadmin == true
}
