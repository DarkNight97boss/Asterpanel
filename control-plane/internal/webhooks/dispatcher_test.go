package webhooks

import "testing"

func TestSignAndVerify(t *testing.T) {
	body := []byte(`{"type":"site.created","id":"abc"}`)
	sig := Sign("topsecret", body)

	if !Verify("topsecret", body, sig) {
		t.Fatal("verify (bare hex) should accept the matching signature")
	}
	if !Verify("topsecret", body, "sha256="+sig) {
		t.Fatal("verify should accept the sha256= prefixed signature")
	}
	if Verify("wrong", body, sig) {
		t.Fatal("verify must reject under a different secret")
	}
	tampered := append([]byte{}, body...)
	tampered[len(tampered)-1] ^= 1
	if Verify("topsecret", tampered, sig) {
		t.Fatal("verify must reject after body tampering")
	}
	if Verify("topsecret", body, "not-hex") {
		t.Fatal("verify must reject a non-hex signature")
	}
}
