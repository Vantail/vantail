//! Reading into a buffer.

/// The part of `buffer` that a read of `count` bytes filled.
///
/// A reader never reports more than the buffer holds. If one did, this
/// answers with the whole buffer rather than panicking.
pub fn filled(buffer: &[u8], count: usize) -> &[u8] {
    match buffer.get(..count) {
        Some(filled) => filled,
        None => buffer,
    }
}
