//! Ed25519 verification of the control plane's signed job bytes.
//!
//! The signature covers the exact request body received, so we verify over the
//! raw bytes — no re-serialization, no cross-language canonicalization risk.

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};

pub struct JobVerifier {
    key: VerifyingKey,
}

impl JobVerifier {
    /// Loads the trusted control-plane public key from a PEM SPKI file
    /// (`openssl pkey -pubout`).
    pub fn from_pem_file(path: &str) -> Result<Self> {
        use ed25519_dalek::pkcs8::DecodePublicKey;
        let pem = std::fs::read_to_string(path)
            .with_context(|| format!("reading trusted pubkey {path}"))?;
        let key = VerifyingKey::from_public_key_pem(&pem)
            .map_err(|e| anyhow!("parsing Ed25519 public key: {e}"))?;
        Ok(Self { key })
    }

    /// Verifies a base64 signature over the exact body bytes. Uses `verify_strict`
    /// to reject malleable/degenerate signatures.
    pub fn verify(&self, body: &[u8], signature_b64: &str) -> Result<()> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(signature_b64)
            .context("decoding signature base64")?;
        let sig =
            Signature::from_slice(&raw).map_err(|e| anyhow!("invalid signature bytes: {e}"))?;
        self.key
            .verify_strict(body, &sig)
            .map_err(|_| anyhow!("signature verification failed"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn verifies_valid_rejects_tampered() {
        // Round-trip with an in-memory key (the real key is loaded from PEM).
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let verifier = JobVerifier {
            key: signing.verifying_key(),
        };
        let body = br#"{"id":"x","type":"website.create"}"#;
        let sig = signing.sign(body);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

        assert!(verifier.verify(body, &sig_b64).is_ok());

        let mut tampered = body.to_vec();
        tampered[0] ^= 0xFF;
        assert!(verifier.verify(&tampered, &sig_b64).is_err());
    }
}
