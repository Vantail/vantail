//! Taking a lock.

use std::sync::{Mutex, MutexGuard};

/// Lock `mutex`, also when another thread panicked while holding it.
///
/// `Mutex::lock` reports that case - a poisoned lock - as an error. A release
/// build cannot reach it: it is built with `panic = "abort"`, so a panic ends
/// the process before anything else can take the lock. A debug build or a
/// test can, and there the panic that poisoned the lock has already been
/// reported. Panicking again here would only take a second thread down with
/// it, so the lock is taken as it is.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}
