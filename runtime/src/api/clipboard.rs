//! `clipboard.*` - system clipboard text and images.
//!
//! Images cross as PNG rather than as raw pixels. The clipboard itself holds
//! RGBA, but PNG is what a page can put straight into an `<img>`, hand to a
//! `Blob`, or write to disk - and converting once here is cheaper than making
//! every application do it.

use std::cell::RefCell;

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::ipc::Request;
use crate::state::Runtime;

thread_local! {
    /// Held open for the life of the thread. On some platforms the clipboard
    /// connection has to outlive the write for the data to stick around.
    static CLIPBOARD: RefCell<Option<arboard::Clipboard>> = const { RefCell::new(None) };
}

#[derive(Deserialize)]
struct TextParams {
    text: String,
}

#[derive(Deserialize)]
struct ImageParams {
    /// A PNG, base64 encoded, the same way binary file contents travel.
    data: String,
}

const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

pub fn dispatch(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    match method {
        "clipboard.readText" => {
            rt.permissions
                .require(rt.permissions.clipboard_read, method)?;
            with_clipboard(|clipboard| {
                clipboard
                    .get_text()
                    .map(Value::from)
                    // An empty clipboard is not an error; it is empty.
                    .or_else(|_| Ok(Value::String(String::new())))
            })
        }

        "clipboard.writeText" => {
            rt.permissions
                .require(rt.permissions.clipboard_write, method)?;
            let TextParams { text } = Request::params(method, params)?;
            with_clipboard(move |clipboard| {
                clipboard
                    .set_text(text)
                    .map(|_| Value::Null)
                    .map_err(|e| ApiError::internal(format!("Could not write the clipboard: {e}")))
            })
        }

        "clipboard.clear" => {
            rt.permissions
                .require(rt.permissions.clipboard_write, method)?;
            with_clipboard(|clipboard| {
                clipboard
                    .clear()
                    .map(|_| Value::Null)
                    .map_err(|e| ApiError::internal(format!("Could not clear the clipboard: {e}")))
            })
        }

        "clipboard.hasText" => {
            rt.permissions
                .require(rt.permissions.clipboard_read, method)?;
            with_clipboard(|clipboard| Ok(json!(clipboard.get_text().is_ok())))
        }

        "clipboard.readImage" => {
            rt.permissions
                .require(rt.permissions.clipboard_read, method)?;
            with_clipboard(|clipboard| match clipboard.get_image() {
                Ok(image) => {
                    let png = encode_png(&image)?;
                    Ok(json!({
                        "width": image.width,
                        "height": image.height,
                        "data": BASE64.encode(png),
                    }))
                }
                // No image on the clipboard is an ordinary answer, not a
                // failure - the same way empty text is.
                Err(_) => Ok(Value::Null),
            })
        }

        "clipboard.writeImage" => {
            rt.permissions
                .require(rt.permissions.clipboard_write, method)?;
            let ImageParams { data } = Request::params(method, params)?;
            let bytes = BASE64
                .decode(data.as_bytes())
                .map_err(|e| ApiError::invalid_params(format!("`data` is not base64: {e}")))?;
            let image = decode_png(&bytes)?;

            with_clipboard(move |clipboard| {
                clipboard
                    .set_image(image)
                    .map(|_| Value::Null)
                    .map_err(|e| ApiError::internal(format!("Could not write the image: {e}")))
            })
        }

        "clipboard.hasImage" => {
            rt.permissions
                .require(rt.permissions.clipboard_read, method)?;
            with_clipboard(|clipboard| Ok(json!(clipboard.get_image().is_ok())))
        }

        _ => Err(ApiError::unknown_method(method)),
    }
}

/// Clipboard RGBA -> PNG.
fn encode_png(image: &arboard::ImageData<'_>) -> Result<Vec<u8>, ApiError> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, image.width as u32, image.height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);

    let mut writer = encoder
        .write_header()
        .map_err(|e| ApiError::internal(format!("Could not encode the image: {e}")))?;
    writer
        .write_image_data(&image.bytes)
        .map_err(|e| ApiError::internal(format!("Could not encode the image: {e}")))?;
    writer
        .finish()
        .map_err(|e| ApiError::internal(format!("Could not encode the image: {e}")))?;

    Ok(out)
}

/// PNG -> clipboard RGBA.
///
/// The clipboard takes one shape only, so anything the encoder produced in
/// another - greyscale, a palette, 16 bits a channel - is converted rather
/// than refused.
fn decode_png(bytes: &[u8]) -> Result<arboard::ImageData<'static>, ApiError> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(
        png::Transformations::normalize_to_color8() | png::Transformations::ALPHA,
    );

    let mut reader = decoder
        .read_info()
        .map_err(|e| ApiError::invalid_params(format!("That is not a PNG: {e}")))?;

    let mut buffer = vec![0; reader.output_buffer_size().unwrap_or(0)];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|e| ApiError::invalid_params(format!("Could not read the PNG: {e}")))?;

    if info.color_type != png::ColorType::Rgba {
        return Err(ApiError::invalid_params(format!(
            "The clipboard needs RGBA, and this PNG is {:?} even after conversion",
            info.color_type
        )));
    }

    buffer.truncate(info.buffer_size());
    Ok(arboard::ImageData {
        width: info.width as usize,
        height: info.height as usize,
        bytes: buffer.into(),
    })
}

fn with_clipboard<F>(action: F) -> ApiResult
where
    F: FnOnce(&mut arboard::Clipboard) -> ApiResult,
{
    CLIPBOARD.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(arboard::Clipboard::new().map_err(|e| {
                ApiError::unsupported(format!("The clipboard is unavailable: {e}"))
            })?);
        }
        action(slot.as_mut().expect("clipboard was just initialised"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(width: usize, height: usize) -> arboard::ImageData<'static> {
        let mut bytes = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                // Something with structure, so a transposed or shifted image
                // does not still compare equal.
                bytes.extend_from_slice(&[(x * 8) as u8, (y * 8) as u8, 0x40, 0xff]);
            }
        }
        arboard::ImageData {
            width,
            height,
            bytes: bytes.into(),
        }
    }

    #[test]
    fn an_image_survives_the_trip_to_png_and_back() {
        let original = sample(9, 5);
        let png = encode_png(&original).expect("encode");

        assert_eq!(&png[1..4], b"PNG", "not a PNG");

        let restored = decode_png(&png).expect("decode");
        assert_eq!(restored.width, original.width);
        assert_eq!(restored.height, original.height);
        assert_eq!(
            restored.bytes.as_ref(),
            original.bytes.as_ref(),
            "the pixels changed"
        );
    }

    #[test]
    fn a_png_without_an_alpha_channel_still_reaches_the_clipboard() {
        // Most screenshots and exports are RGB, and the clipboard only takes
        // RGBA - so the conversion has to happen rather than be refused.
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, 2, 2);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("header");
        writer
            .write_image_data(&[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])
            .expect("data");
        writer.finish().expect("finish");

        let image = decode_png(&out).expect("an RGB png should convert");
        assert_eq!(image.width, 2);
        assert_eq!(image.height, 2);
        assert_eq!(image.bytes.len(), 2 * 2 * 4, "should be RGBA now");
        assert_eq!(&image.bytes[0..4], &[255, 0, 0, 255], "first pixel");
    }

    #[test]
    fn something_that_is_not_a_png_is_rejected_as_bad_input() {
        let error = decode_png(b"definitely not a png").expect_err("should refuse");
        assert_eq!(error.code, crate::error::code::INVALID_PARAMS);
    }
}
