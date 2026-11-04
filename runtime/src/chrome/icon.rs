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
    let file = std::fs::File::open(path).map_err(|e| {
        ApiError::io(&format!("Could not open the icon {}", path.display()), e)
    })?;

    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(
        png::Transformations::normalize_to_color8()
            | png::Transformations::ALPHA,
    );

    let mut reader = decoder.read_info().map_err(|e| {
        ApiError::invalid_params(format!(
            "{} is not a valid PNG: {e}",
            path.display()
        ))
    })?;

    let size = match reader.output_buffer_size() {
        Some(size) => size,
        None => 0,
    };
    let mut buffer = vec![0; size];
    let info = reader.next_frame(&mut buffer).map_err(|e| {
        ApiError::invalid_params(format!(
            "Could not decode {}: {e}",
            path.display()
        ))
    })?;

    let pixels = (info.width as usize) * (info.height as usize);
    let bytes = match info.color_type {
        png::ColorType::Rgba => image_data(&buffer, pixels * 4, path)?.to_vec(),
        png::ColorType::Rgb => {
            expand(image_data(&buffer, pixels * 3, path)?, 3, pixels)
        }
        png::ColorType::GrayscaleAlpha => {
            grey(image_data(&buffer, pixels * 2, path)?, true, pixels)
        }
        png::ColorType::Grayscale => {
            grey(image_data(&buffer, pixels, path)?, false, pixels)
        }
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

/// The decoded image: the first `length` bytes of what the decoder produced.
/// A decoder that produced fewer was given a PNG smaller than its own header
/// says.
fn image_data<'a>(
    buffer: &'a [u8],
    length: usize,
    path: &Path,
) -> Result<&'a [u8], ApiError> {
    match buffer.get(..length) {
        Some(data) => Ok(data),
        None => Err(ApiError::invalid_params(format!(
            "{} has less image data than its size says",
            path.display()
        ))),
    }
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
        let (value, alpha) = match pixel {
            [value, alpha] => (*value, *alpha),
            [value] => (*value, 255),
            // `chunks_exact` only hands out chunks of `stride`, one or two.
            _ => continue,
        };
        out.extend_from_slice(&[value, value, value, alpha]);
    }
    out
}
