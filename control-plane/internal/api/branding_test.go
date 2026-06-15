package api

import "testing"

func TestIsHexColor(t *testing.T) {
	valid := []string{"#6366f1", "#000000", "#FFFFFF", "#AbC123"}
	for _, c := range valid {
		if !isHexColor(c) {
			t.Errorf("expected %q to be valid", c)
		}
	}
	invalid := []string{"6366f1", "#fff", "#1234567", "#12345g", "", "red", "#６６６６６６"}
	for _, c := range invalid {
		if isHexColor(c) {
			t.Errorf("expected %q to be invalid", c)
		}
	}
}
