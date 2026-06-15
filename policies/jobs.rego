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
	"cert.issue",
	"dns.apply",
	"backup.create",
	"backup.restore",
	"database.create",
	"database.delete",
	"mail.mailbox.create",
	"health.check",
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
