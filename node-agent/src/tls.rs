//! mTLS server configuration. The agent presents its node certificate and
//! *requires* a client certificate chained to the project CA — only the control
//! plane holds such a certificate, so nothing else can even open a connection.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig};

pub fn server_config(cert_path: &str, key_path: &str, ca_path: &str) -> Result<Arc<ServerConfig>> {
    // Install the process-wide crypto provider (ring) once; ignore "already set".
    let _ = rustls::crypto::ring::default_provider().install_default();

    let certs = load_certs(cert_path).with_context(|| format!("loading agent cert {cert_path}"))?;
    let key = load_key(key_path).with_context(|| format!("loading agent key {key_path}"))?;

    let mut roots = RootCertStore::empty();
    for ca in load_certs(ca_path).with_context(|| format!("loading CA {ca_path}"))? {
        roots
            .add(ca)
            .map_err(|e| anyhow!("adding CA to root store: {e}"))?;
    }
    let verifier = WebPkiClientVerifier::builder(Arc::new(roots))
        .build()
        .map_err(|e| anyhow!("building client verifier: {e}"))?;

    let config = ServerConfig::builder()
        .with_client_cert_verifier(verifier)
        .with_single_cert(certs, key)
        .map_err(|e| anyhow!("building server config: {e}"))?;

    Ok(Arc::new(config))
}

fn load_certs(path: &str) -> Result<Vec<CertificateDer<'static>>> {
    let data = std::fs::read(path)?;
    let mut reader = std::io::BufReader::new(&data[..]);
    let certs = rustls_pemfile::certs(&mut reader).collect::<std::result::Result<Vec<_>, _>>()?;
    if certs.is_empty() {
        return Err(anyhow!("no certificates in {path}"));
    }
    Ok(certs)
}

fn load_key(path: &str) -> Result<PrivateKeyDer<'static>> {
    let data = std::fs::read(path)?;
    let mut reader = std::io::BufReader::new(&data[..]);
    rustls_pemfile::private_key(&mut reader)?.ok_or_else(|| anyhow!("no private key in {path}"))
}
