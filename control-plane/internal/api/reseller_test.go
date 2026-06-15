package api

import "testing"

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Acme Corp":         "acme-corp",
		"  Hello,  World! ": "hello-world",
		"Café à Paris":      "caf-paris",
		"already-slug":      "already-slug",
		"###":               "org",
		"":                  "org",
	}
	for in, want := range cases {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}
