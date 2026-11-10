//! A key of the tunnel's, as a file keeps it: its 32 secret bytes, as hex, read alone by the person it is theirs, made
//! once where there is none.

use std::path::Path;

use iroh::SecretKey;

/// The key the file at `path` keeps, made and kept there where it keeps none.
///
/// # Errors
/// Where the file cannot be read or written, or keeps what is no key.
pub fn load_or_make(path: &Path) -> std::io::Result<SecretKey> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(text.trim()).ok_or_else(|| std::io::Error::other(format!("{} keeps no key", path.display()))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let key = SecretKey::generate();
            write(path, &key)?;
            Ok(key)
        }
        Err(error) => Err(error),
    }
}

fn parse(hex: &str) -> Option<SecretKey> {
    if hex.len() != 64 {
        return None;
    }
    let mut bytes = [0; 32];
    for (at, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(at * 2..at * 2 + 2)?, 16).ok()?;
    }
    Some(SecretKey::from_bytes(&bytes))
}

fn write(path: &Path, key: &SecretKey) -> std::io::Result<()> {
    use std::fmt::Write as _;
    use std::io::Write as _;
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let hex = key.to_bytes().iter().fold(String::with_capacity(64), |mut hex, byte| {
        let _ = write!(hex, "{byte:02x}");
        hex
    });
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(hex.as_bytes())
}
