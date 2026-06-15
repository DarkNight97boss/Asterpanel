package asterpanel.jobs_test

import rego.v1

import data.asterpanel.jobs

test_known_type_same_tenant_allowed if {
	jobs.allow with input as {
		"job_type": "website.create",
		"tenant_id": "org1",
		"node_id": "node1",
		"subject": {"org_id": "org1", "superadmin": false},
	}
}

test_unknown_type_denied if {
	not jobs.allow with input as {
		"job_type": "evil.exec",
		"tenant_id": "org1",
		"subject": {"org_id": "org1", "superadmin": false},
	}
}

test_cross_tenant_denied if {
	not jobs.allow with input as {
		"job_type": "website.create",
		"tenant_id": "org2",
		"subject": {"org_id": "org1", "superadmin": false},
	}
}

test_superadmin_cross_tenant_allowed if {
	jobs.allow with input as {
		"job_type": "app.deploy",
		"tenant_id": "org2",
		"subject": {"org_id": "org1", "superadmin": true},
	}
}
