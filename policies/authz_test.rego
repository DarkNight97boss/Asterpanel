package asterpanel.authz_test

import rego.v1

import data.asterpanel.authz

test_superadmin_allowed if {
	authz.allow with input as {
		"action": "node.delete",
		"permission": "node.delete",
		"subject": {"user_id": "u1", "superadmin": true, "permissions": []},
	}
}

test_permission_allows if {
	authz.allow with input as {
		"action": "website.create",
		"permission": "website.create",
		"subject": {"user_id": "u1", "superadmin": false, "permissions": ["website.create", "website.read"]},
	}
}

test_missing_permission_denied if {
	not authz.allow with input as {
		"action": "website.create",
		"permission": "website.create",
		"subject": {"user_id": "u1", "superadmin": false, "permissions": ["website.read"]},
	}
}

test_api_token_scope_allows if {
	authz.allow with input as {
		"action": "deploy.create",
		"permission": "deploy.create",
		"subject": {"user_id": "u1", "is_api_token": true, "scopes": ["deploy.create"], "permissions": []},
	}
}

test_api_token_without_scope_denied if {
	not authz.allow with input as {
		"action": "deploy.create",
		"permission": "deploy.create",
		"subject": {"user_id": "u1", "is_api_token": true, "scopes": ["website.read"], "permissions": []},
	}
}
