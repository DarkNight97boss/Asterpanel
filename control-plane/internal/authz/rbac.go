// Package authz holds authorization: the RBAC permission set and the OPA policy
// decision client. Authorization is deny-by-default: a request must satisfy both
// the required RBAC permission and (for sensitive actions) the OPA policy.
package authz

// PermissionSet is the set of permission keys a principal holds in a tenant.
type PermissionSet map[string]struct{}

func NewPermissionSet(keys []string) PermissionSet {
	s := make(PermissionSet, len(keys))
	for _, k := range keys {
		s[k] = struct{}{}
	}
	return s
}

func (s PermissionSet) Has(key string) bool {
	_, ok := s[key]
	return ok
}

// HasAll reports whether every key is present.
func (s PermissionSet) HasAll(keys ...string) bool {
	for _, k := range keys {
		if !s.Has(k) {
			return false
		}
	}
	return true
}

func (s PermissionSet) Keys() []string {
	out := make([]string, 0, len(s))
	for k := range s {
		out = append(out, k)
	}
	return out
}
