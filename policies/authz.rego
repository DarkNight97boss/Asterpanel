# Authorization policy for control-plane API actions.
# Queried at POST /v1/data/asterpanel/authz; the result document is {allow, reasons}.
package asterpanel.authz

import rego.v1

# Deny by default — authorization is allowlist-based.
default allow := false

# Superadmins may perform any action.
allow if input.subject.superadmin == true

# RBAC: the subject's role grants the required permission.
allow if {
	some perm in input.subject.permissions
	perm == input.permission
}

# API tokens are authorized by their explicit scopes.
allow if {
	input.subject.is_api_token == true
	some scope in input.subject.scopes
	scope == input.permission
}

# Human-readable denial reasons (recorded in the audit log).
reasons contains msg if {
	not allow
	msg := sprintf(
		"subject %q lacks permission %q required by action %q",
		[input.subject.user_id, input.permission, input.action],
	)
}
