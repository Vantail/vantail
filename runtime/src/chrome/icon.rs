//! Loading a PNG into the RGBA buffer that tray and window icons want.

use std::path::Path;

use crate::error::ApiError;

pub struct Rgba {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Decode a PNG, whatever colour type it happens to use.
///
/// Icons come from designers, and designers export greyscale, palette and
/// 16-bit PNGs without thinking about it. Normalising here means an icon that
/// looks fine in a viewer also works in the tray.
pub fn load_png(path: &Path) -> Result<Rgba, ApiError> {
    let file = std::fs::File::open(path)
        .map_err(|e| ApiError::io(&format!("Could not open the icon {}", path.display()), e))?;

    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(
        png::Transformations::normalize_to_color8() | png::Transformations::ALPHA,
    );

    let mut reader = decoder.read_info().map_err(|e| {
        ApiError::invalid_params(format!("{} is not a valid PNG: {e}", path.display()))
    })?;

    let mut buffer = vec![0; reader.output_buffer_size().unwrap_or(0)];
    let info = reader.next_frame(&mut buffer).map_err(|e| {
        ApiError::invalid_params(format!("Could not decode {}: {e}", path.display()))
    })?;

    let pixels = (info.width as usize) * (info.height as usize);
    let bytes = match info.color_type {
        png::ColorType::Rgba => buffer[..pixels * 4].to_vec(),
        png::ColorType::Rgb => expand(&buffer[..pixels * 3], 3, pixels),
        png::ColorType::GrayscaleAlpha => grey(&buffer[..pixels * 2], true, pixels),
        png::ColorType::Grayscale => grey(&buffer[..pixels], false, pixels),
        other => {
            return Err(ApiError::unsupported(format!(
                "{} uses an unsupported PNG colour type ({other:?})",
                path.display()
            )))
        }
    };

    Ok(Rgba {
        bytes,
        width: info.width,
        height: info.height,
    })
}

fn expand(source: &[u8], stride: usize, pixels: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixels * 4);
    for pixel in source.chunks_exact(stride) {
        out.extend_from_slice(pixel);
        out.push(255);
    }
    out
}

fn grey(source: &[u8], has_alpha: bool, pixels: usize) -> Vec<u8> {
    let stride = if has_alpha { 2 } else { 1 };
    let mut out = Vec::with_capacity(pixels * 4);
    for pixel in source.chunks_exact(stride) {
        let value = pixel[0];
        out.extend_from_slice(&[value, value, value]);
        out.push(if has_alpha { pixel[1] } else { 255 });
    }
    out
}
