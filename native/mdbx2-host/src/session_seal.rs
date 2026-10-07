//! DPAPI sealing for the persisted vault session key.
//!
//! The Host does not decide when a session is persisted.  It only wraps and
//! unwraps the raw vault key with Windows DPAPI in current-user scope, so the
//! extension can keep a session across browser restarts without writing the key
//! to disk in plaintext.
//!
//! Scope note: DPAPI trusts the Windows logon session, so any process running
//! as the same user can call the same API.  Sealing therefore protects the key
//! at rest (offline disks, other accounts, copied profile folders) and nothing
//! more.  The Host never logs, stores or returns the key to any other caller.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Map, Value};
use zeroize::Zeroize;

use crate::runtime::RpcFailure;

pub const SESSION_SEAL_PROTOCOL_VERSION: u32 = 1;

/// The vault session key is 32 bytes; the bound leaves room for key material.
const MAX_PLAINTEXT_BYTES: usize = 128;
/// DPAPI output for a 32-byte input is roughly 200 bytes.
const MAX_SEALED_BYTES: usize = 4096;
/// Additional entropy binds a blob to this purpose, so a copied blob cannot be
/// unsealed by an unrelated caller that omits the entropy.
const ENTROPY: &[u8] = b"monica.extension.secureVault.session.v1";

pub fn seal(params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "session.seal params must be an object.")?;
    let mut plaintext = take_base64(&mut params, "plaintextBase64", "会话密钥缺失。", MAX_PLAINTEXT_BYTES)?;
    reject_unknown(params)?;
    let sealed = platform_seal(&plaintext);
    plaintext.zeroize();
    Ok(json!({ "sealedBase64": STANDARD.encode(sealed?) }))
}

pub fn unseal(params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "session.unseal params must be an object.")?;
    let sealed = take_base64(&mut params, "sealedBase64", "加密会话密钥缺失。", MAX_SEALED_BYTES)?;
    reject_unknown(params)?;
    let mut plaintext = platform_unseal(&sealed)?;
    let encoded = STANDARD.encode(&plaintext);
    plaintext.zeroize();
    Ok(json!({ "plaintextBase64": encoded }))
}

fn take_object(value: Value, message: &str) -> Result<Map<String, Value>, RpcFailure> {
    match value {
        Value::Object(value) => Ok(value),
        _ => Err(RpcFailure::invalid(message)),
    }
}

fn reject_unknown(value: Map<String, Value>) -> Result<(), RpcFailure> {
    if value.is_empty() {
        Ok(())
    } else {
        Err(RpcFailure::invalid("会话密钥参数包含未知字段。"))
    }
}

fn take_base64(
    params: &mut Map<String, Value>,
    key: &str,
    missing: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, RpcFailure> {
    let value = params.remove(key).ok_or_else(|| RpcFailure::invalid(missing))?;
    let Value::String(value) = value else {
        return Err(RpcFailure::invalid("会话密钥参数必须是 Base64 字符串。"));
    };
    let bytes = STANDARD
        .decode(value.as_bytes())
        .map_err(|_| RpcFailure::invalid("会话密钥参数不是有效的 Base64。"))?;
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(RpcFailure::invalid("会话密钥参数长度无效。"));
    }
    Ok(bytes)
}

#[cfg(windows)]
fn platform_seal(plaintext: &[u8]) -> Result<Vec<u8>, RpcFailure> {
    windows_platform::protect(plaintext)
}

#[cfg(windows)]
fn platform_unseal(sealed: &[u8]) -> Result<Vec<u8>, RpcFailure> {
    windows_platform::unprotect(sealed)
}

#[cfg(not(windows))]
fn platform_seal(_: &[u8]) -> Result<Vec<u8>, RpcFailure> {
    Err(RpcFailure::new(
        "session-seal-unsupported",
        "会话密钥保护仅支持 Windows。",
        false,
    ))
}

#[cfg(not(windows))]
fn platform_unseal(_: &[u8]) -> Result<Vec<u8>, RpcFailure> {
    Err(RpcFailure::new(
        "session-seal-unsupported",
        "会话密钥保护仅支持 Windows。",
        false,
    ))
}

#[cfg(windows)]
mod windows_platform {
    use super::*;
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    fn failure(action: &str) -> RpcFailure {
        let code = unsafe { GetLastError() };
        RpcFailure::new(
            "session-seal-native-error",
            format!("会话密钥{action}失败（DPAPI {code}）。"),
            false,
        )
    }

    /// Copies a DPAPI output blob and always releases the DPAPI allocation.
    fn take_output(output: CRYPT_INTEGER_BLOB, action: &str) -> Result<Vec<u8>, RpcFailure> {
        if output.pbData.is_null() || output.cbData == 0 {
            return Err(failure(action));
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe { LocalFree(output.pbData as *mut core::ffi::c_void) };
        Ok(bytes)
    }

    pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, RpcFailure> {
        let input = blob(plaintext);
        let entropy = blob(ENTROPY);
        let mut output = CRYPT_INTEGER_BLOB::default();
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(failure("加密"));
        }
        take_output(output, "加密")
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, RpcFailure> {
        let input = blob(sealed);
        let entropy = blob(ENTROPY);
        let mut output = CRYPT_INTEGER_BLOB::default();
        let mut description: *mut u16 = std::ptr::null_mut();
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                &mut description,
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if !description.is_null() {
            unsafe { LocalFree(description as *mut core::ffi::c_void) };
        }
        if ok == 0 {
            return Err(failure("解密"));
        }
        take_output(output, "解密")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_malformed_parameters_before_platform_calls() {
        assert_eq!(seal(json!({})).unwrap_err().code, "params-invalid");
        assert_eq!(
            seal(json!({ "plaintextBase64": "not base64!" })).unwrap_err().code,
            "params-invalid"
        );
        assert_eq!(
            seal(json!({ "plaintextBase64": STANDARD.encode(vec![1_u8; MAX_PLAINTEXT_BYTES + 1]) }))
                .unwrap_err()
                .code,
            "params-invalid"
        );
        assert_eq!(
            seal(json!({ "plaintextBase64": STANDARD.encode([1_u8; 32]), "extra": true }))
                .unwrap_err()
                .code,
            "params-invalid"
        );
        assert_eq!(unseal(json!({})).unwrap_err().code, "params-invalid");
        assert_eq!(
            unseal(json!({ "sealedBase64": STANDARD.encode([1_u8; 8]) }))
                .map(|_| ())
                .is_err(),
            true
        );
    }

    #[cfg(windows)]
    #[test]
    fn round_trips_the_session_key_through_dpapi() {
        let key = [7_u8; 32];
        let sealed = seal(json!({ "plaintextBase64": STANDARD.encode(key) })).unwrap();
        let sealed_base64 = sealed["sealedBase64"].as_str().unwrap().to_string();
        assert!(
            !sealed_base64.contains(&STANDARD.encode(key)),
            "the sealed blob must not contain the raw session key"
        );
        let opened = unseal(json!({ "sealedBase64": sealed_base64 })).unwrap();
        assert_eq!(
            STANDARD.decode(opened["plaintextBase64"].as_str().unwrap()).unwrap(),
            key
        );
    }

    #[cfg(windows)]
    #[test]
    fn refuses_a_tampered_blob() {
        let sealed = seal(json!({ "plaintextBase64": STANDARD.encode([9_u8; 32]) })).unwrap();
        let mut bytes = STANDARD
            .decode(sealed["sealedBase64"].as_str().unwrap())
            .unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        assert!(unseal(json!({ "sealedBase64": STANDARD.encode(bytes) })).is_err());
    }
}
