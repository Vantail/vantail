//! `hid.*` - raw access to USB HID devices.
//!
//! WebHID does not exist in the webviews Vantail runs on, so a control pad, a
//! foot pedal or a custom macro pad is simply unreachable from a page. This
//! is the one capability that is device-shaped, which is exactly why it stays
//! generic: Vantail knows what a HID report is and has never heard of any particular device.
//! The application implements the protocol; the platform hands it bytes.
//!
//! Each open device gets a thread that reads it. Reads use a short timeout
//! rather than blocking, so a write is never queued behind a device that has
//! nothing to say.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use hidapi::{HidApi, HidDevice};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{code, ApiError, ApiResult};
use crate::ipc::{Event, Outgoing, Request};
use crate::state::Runtime;

const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// How long a read waits before letting go of the device so a write can get
/// in. Short enough to feel immediate, long enough not to spin.
const READ_TIMEOUT_MS: i32 = 50;

/// Nothing sends reports anywhere near this large; the buffer is just a cap.
const MAX_REPORT_BYTES: usize = 8 * 1024;

#[derive(Deserialize)]
struct IdParams {
    id: String,
}

#[derive(Deserialize)]
struct HandleParams {
    handle: u32,
}

#[derive(Deserialize)]
struct WriteParams {
    handle: u32,
    /// Base64. The first byte is the report id - `0` for devices that do not
    /// use numbered reports.
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeatureParams {
    handle: u32,
    report_id: u8,
    /// How many bytes to ask for, not counting the report id.
    length: usize,
}

struct Open {
    path: String,
    vendor_id: u16,
    product_id: u16,
    device: Arc<Mutex<HidDevice>>,
    reading: Arc<AtomicBool>,
    /// How many calls are waiting for the device.
    ///
    /// A plain mutex is not fair, and the read loop re-locks the moment it
    /// lets go, so a caller racing it loses again and again: measured waits
    /// ran to several seconds for a call that takes under a millisecond. This
    /// is how the reader learns to stand aside.
    waiting: Arc<Turnstile>,
}

/// Keeps the read loop from starving the calls it shares a device with.
///
/// A caller announces itself before blocking on the lock, so the reader can
/// see the intent even while the caller is asleep in `lock()`.
#[derive(Default)]
struct Turnstile {
    waiting: AtomicUsize,
}

impl Turnstile {
    /// Announce a caller. The count falls again when the guard is dropped,
    /// including if the work panics - a leaked count would stop the reader
    /// for good.
    fn enter(&self) -> Waiting<'_> {
        self.waiting.fetch_add(1, Ordering::Release);
        Waiting(self)
    }

    /// Whether the reader should stand aside rather than take the device.
    fn busy(&self) -> bool {
        self.waiting.load(Ordering::Acquire) > 0
    }
}

struct Waiting<'a>(&'a Turnstile);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.waiting.fetch_sub(1, Ordering::Release);
    }
}

/// Take the device for an API call, ahead of the read loop.
fn borrow<T>(entry: &Open, work: impl FnOnce(&HidDevice) -> T) -> T {
    let _waiting = entry.waiting.enter();
    let device = entry.device.lock().expect("hid device poisoned");
    work(&device)
}

/// Open devices, and the enumeration handle they came from.
#[derive(Default)]
pub struct Devices {
    api: Mutex<Option<HidApi>>,
    open: Mutex<HashMap<u32, Arc<Open>>>,
    next: AtomicU32,
}

impl Devices {
    fn api<T>(
        &self,
        action: impl FnOnce(&mut HidApi) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let mut slot = self.api.lock().expect("hid api poisoned");
        if slot.is_none() {
            // Created on first use: initialising HID opens platform handles,
            // and an application that never touches a device should not.
            *slot = Some(HidApi::new().map_err(|e| {
                ApiError::unsupported(format!("HID is unavailable on this system: {e}"))
            })?);
        }
        action(slot.as_mut().expect("just created"))
    }

    fn get(&self, handle: u32) -> Option<Arc<Open>> {
        self.open
            .lock()
            .expect("hid devices poisoned")
            .get(&handle)
            .cloned()
    }

    fn remove(&self, handle: u32) -> Option<Arc<Open>> {
        self.open
            .lock()
            .expect("hid devices poisoned")
            .remove(&handle)
    }

    /// Close everything on the way out.
    pub fn shutdown(&self) {
        let open = std::mem::take(&mut *self.open.lock().expect("hid devices poisoned"));
        for (_, device) in open {
            device.reading.store(false, Ordering::Relaxed);
        }
    }
}

pub fn dispatch(rt: &Arc<Runtime>, source: &str, method: &str, params: Value) -> ApiResult {
    match method {
        "hid.list" => list(rt),
        "hid.open" => open(rt, source, method, params),
        "hid.close" => close(rt, method, params),
        "hid.opened" => Ok(json!(opened(rt))),
        "hid.write" => write(rt, method, params),
        "hid.sendFeatureReport" => send_feature(rt, method, params),
        "hid.getFeatureReport" => get_feature(rt, method, params),
        _ => Err(ApiError::unknown_method(method)),
    }
}

/// Devices this application is allowed to open.
///
/// Filtered rather than listed in full: an application permitted to talk to
/// one vendor's hardware has no business learning what else is plugged in.
fn list(rt: &Runtime) -> ApiResult {
    rt.devices.api(|api| {
        api.refresh_devices()
            .map_err(|e| ApiError::internal(format!("Could not enumerate HID devices: {e}")))?;

        let devices: Vec<Value> = api
            .device_list()
            .filter(|info| {
                rt.permissions
                    .allows_device(info.vendor_id(), info.product_id(), info.usage_page())
            })
            .map(|info| {
                json!({
                    "id": info.path().to_string_lossy(),
                    "vendorId": info.vendor_id(),
                    "productId": info.product_id(),
                    "manufacturer": info.manufacturer_string(),
                    "product": info.product_string(),
                    "serialNumber": info.serial_number(),
                    "usagePage": info.usage_page(),
                    "usage": info.usage(),
                    "interface": info.interface_number(),
                })
            })
            .collect();

        Ok(Value::Array(devices))
    })
}

fn open(rt: &Arc<Runtime>, source: &str, method: &str, params: Value) -> ApiResult {
    let IdParams { id } = Request::params(method, params)?;

    // Look the device up first, so the permission check is against what the
    // device actually reports rather than what the caller claims it is.
    let (vendor_id, product_id, usage_page) = rt.devices.api(|api| {
        api.refresh_devices()
            .map_err(|e| ApiError::internal(format!("Could not enumerate HID devices: {e}")))?;
        api.device_list()
            .find(|info| info.path().to_string_lossy() == id)
            .map(|info| (info.vendor_id(), info.product_id(), info.usage_page()))
            .ok_or_else(|| ApiError::new(code::NOT_FOUND, format!("No HID device with id `{id}`")))
    })?;

    rt.permissions
        .check_device(vendor_id, product_id, usage_page)?;

    let path = std::ffi::CString::new(id.clone())
        .map_err(|_| ApiError::invalid_params("That device id is not a usable path"))?;

    let device = rt.devices.api(|api| {
        api.open_path(&path).map_err(|e| {
            ApiError::new(
                code::IO_ERROR,
                format!(
                    "Could not open `{id}`: {e}. Another application may have it open \
                     exclusively, or the system may not permit access to this device."
                ),
            )
        })
    })?;

    let handle = rt.devices.next.fetch_add(1, Ordering::Relaxed) + 1;
    let entry = Arc::new(Open {
        path: id,
        vendor_id,
        product_id,
        device: Arc::new(Mutex::new(device)),
        reading: Arc::new(AtomicBool::new(true)),
        waiting: Arc::new(Turnstile::default()),
    });

    rt.devices
        .open
        .lock()
        .expect("hid devices poisoned")
        .insert(handle, Arc::clone(&entry));

    read_loop(rt, source, handle, &entry);

    Ok(json!({ "handle": handle, "vendorId": vendor_id, "productId": product_id }))
}

/// One thread per device, reading until it is closed or goes away.
fn read_loop(rt: &Arc<Runtime>, source: &str, handle: u32, entry: &Arc<Open>) {
    let rt = Arc::clone(rt);
    let source = source.to_string();
    let device = Arc::clone(&entry.device);
    let reading = Arc::clone(&entry.reading);
    let waiting = Arc::clone(&entry.waiting);

    let spawned = std::thread::Builder::new()
        .name(format!("vantail-hid-{handle}"))
        .spawn(move || {
            let mut buffer = vec![0_u8; MAX_REPORT_BYTES];
            let mut reason = "closed";

            while reading.load(Ordering::Relaxed) {
                // Releasing the lock is not enough on its own: this loop takes
                // it again immediately, and an unfair mutex hands it straight
                // back. A call that wants the device says so, and this waits
                // for it rather than racing.
                if waiting.busy() {
                    std::thread::sleep(std::time::Duration::from_micros(200));
                    continue;
                }

                let read = {
                    let device = device.lock().expect("hid device poisoned");
                    device.read_timeout(&mut buffer, READ_TIMEOUT_MS)
                };

                match read {
                    Ok(0) => continue,
                    Ok(count) => rt.send(
                        Some(source.clone()),
                        Outgoing::Event(Event::new(
                            "hid.input",
                            json!({ "handle": handle, "data": BASE64.encode(&buffer[..count]) }),
                        )),
                    ),
                    Err(_) => {
                        // Almost always the device being unplugged.
                        reason = "disconnected";
                        break;
                    }
                }
            }

            rt.devices.remove(handle);
            rt.send(
                Some(source),
                Outgoing::Event(Event::new(
                    "hid.closed",
                    json!({ "handle": handle, "reason": reason }),
                )),
            );
        });

    if spawned.is_err() {
        entry.reading.store(false, Ordering::Relaxed);
    }
}

fn close(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    let HandleParams { handle } = Request::params(method, params)?;
    match rt.devices.get(handle) {
        Some(entry) => {
            // The reader notices, emits `hid.closed` and drops the device.
            entry.reading.store(false, Ordering::Relaxed);
            Ok(json!(true))
        }
        None => Ok(json!(false)),
    }
}

fn opened(rt: &Runtime) -> Vec<Value> {
    rt.devices
        .open
        .lock()
        .expect("hid devices poisoned")
        .iter()
        .map(|(handle, entry)| {
            json!({
                "handle": handle,
                "id": entry.path,
                "vendorId": entry.vendor_id,
                "productId": entry.product_id,
            })
        })
        .collect()
}

fn write(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    let WriteParams { handle, data } = Request::params(method, params)?;
    let bytes = decode(&data)?;
    let entry = require(rt, handle)?;

    let written = borrow(&entry, |device| device.write(&bytes));

    written.map(|count| json!(count)).map_err(|e| {
        ApiError::new(
            code::IO_ERROR,
            format!("Could not write to the device: {e}"),
        )
    })
}

fn send_feature(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    let WriteParams { handle, data } = Request::params(method, params)?;
    let bytes = decode(&data)?;
    let entry = require(rt, handle)?;

    let sent = borrow(&entry, |device| device.send_feature_report(&bytes));

    sent.map(|()| Value::Null).map_err(|e| {
        ApiError::new(
            code::IO_ERROR,
            format!("Could not send the feature report: {e}"),
        )
    })
}

fn get_feature(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    let FeatureParams {
        handle,
        report_id,
        length,
    } = Request::params(method, params)?;
    if length > MAX_REPORT_BYTES {
        return Err(ApiError::invalid_params(format!(
            "A feature report may be at most {MAX_REPORT_BYTES} bytes"
        )));
    }
    let entry = require(rt, handle)?;

    // hidapi wants the report id in the first byte of the buffer it fills.
    let mut buffer = vec![0_u8; length + 1];
    buffer[0] = report_id;

    let read = borrow(&entry, |device| device.get_feature_report(&mut buffer));

    read.map(|count| json!(BASE64.encode(&buffer[..count])))
        .map_err(|e| {
            ApiError::new(
                code::IO_ERROR,
                format!("Could not read the feature report: {e}"),
            )
        })
}

fn require(rt: &Runtime, handle: u32) -> Result<Arc<Open>, ApiError> {
    rt.devices.get(handle).ok_or_else(|| {
        ApiError::new(
            code::NOT_FOUND,
            format!("No open HID device with handle {handle}"),
        )
    })
}

fn decode(data: &str) -> Result<Vec<u8>, ApiError> {
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| ApiError::invalid_params(format!("`data` is not valid base64: {e}")))?;

    if bytes.is_empty() {
        return Err(ApiError::invalid_params(
            "A report needs at least a report id byte - use 0 for devices without numbered reports",
        ));
    }
    if bytes.len() > MAX_REPORT_BYTES {
        return Err(ApiError::invalid_params(format!(
            "A report may be at most {MAX_REPORT_BYTES} bytes"
        )));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    /// The read loop, with the blocking read stood in for by a sleep.
    ///
    /// No device is involved: what is being tested is who gets the lock, and
    /// that is decided by the turnstile rather than by hidapi.
    fn reader(
        device: Arc<Mutex<()>>,
        turnstile: Arc<Turnstile>,
        running: Arc<AtomicBool>,
        polite: bool,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            while running.load(Ordering::Relaxed) {
                if polite && turnstile.busy() {
                    std::thread::sleep(Duration::from_micros(200));
                    continue;
                }
                let _held = device.lock().expect("poisoned");
                std::thread::sleep(Duration::from_millis(READ_TIMEOUT_MS as u64));
            }
        })
    }

    /// How long a caller waits for the device, worst of several attempts.
    fn worst_wait(polite: bool) -> Duration {
        let device = Arc::new(Mutex::new(()));
        let turnstile = Arc::new(Turnstile::default());
        let running = Arc::new(AtomicBool::new(true));

        let handle = reader(
            Arc::clone(&device),
            Arc::clone(&turnstile),
            Arc::clone(&running),
            polite,
        );

        // Let the reader get into its loop first.
        std::thread::sleep(Duration::from_millis(120));

        let mut worst = Duration::ZERO;
        for _ in 0..8 {
            let start = Instant::now();
            {
                let _waiting = turnstile.enter();
                let _held = device.lock().expect("poisoned");
            }
            worst = worst.max(start.elapsed());
            std::thread::sleep(Duration::from_millis(5));
        }

        running.store(false, Ordering::Relaxed);
        handle.join().expect("reader panicked");
        worst
    }

    #[test]
    fn a_caller_waits_no_longer_than_one_read() {
        // The bug this guards: an unfair mutex plus a loop that re-locks
        // immediately starved callers for seconds at a time. Bounded now by
        // the one read that may already be in flight, with room for a slow
        // machine on top.
        let worst = worst_wait(true);

        assert!(
            worst < Duration::from_millis(READ_TIMEOUT_MS as u64 * 4),
            "waited {worst:?}, which means the reader is not standing aside"
        );
    }

    #[test]
    fn the_count_falls_again_when_the_caller_panics() {
        // A leaked count would stop the reader for the life of the device.
        let turnstile = Arc::new(Turnstile::default());
        let taken = Arc::clone(&turnstile);

        let panicked = std::thread::spawn(move || {
            let _waiting = taken.enter();
            panic!("the work failed");
        })
        .join();

        assert!(panicked.is_err(), "the thread was supposed to panic");
        assert!(!turnstile.busy(), "the reader would never take the device again");
    }
}
