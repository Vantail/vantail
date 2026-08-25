//! A small fixed thread pool for blocking native work.
//!
//! Filesystem calls must not run on the event loop thread or the window stops
//! painting. They also must not get a thread each - a `for` loop in the app
//! would then spawn thousands. A fixed pool with a queue is the boring answer.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use crate::error::ApiError;

type Job = Box<dyn FnOnce() + Send + 'static>;

pub struct Pool {
    tx: Sender<Job>,
    _workers: Vec<std::thread::JoinHandle<()>>,
}

impl Pool {
    pub fn new(size: usize) -> Self {
        let (tx, rx) = channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        let mut workers = Vec::with_capacity(size);

        for index in 0..size {
            let rx: Arc<Mutex<Receiver<Job>>> = Arc::clone(&rx);
            let handle = std::thread::Builder::new()
                .name(format!("vantail-worker-{index}"))
                .spawn(move || loop {
                    // Take the lock only long enough to claim a job, so
                    // workers do not serialise on each other while running.
                    let job = {
                        let guard = match rx.lock() {
                            Ok(guard) => guard,
                            Err(_) => break,
                        };
                        guard.recv()
                    };
                    match job {
                        Ok(job) => job(),
                        // The sender is gone: the runtime is shutting down.
                        Err(_) => break,
                    }
                })
                .expect("could not start a Vantail worker thread");
            workers.push(handle);
        }

        Self {
            tx,
            _workers: workers,
        }
    }

    pub fn execute(&self, job: impl FnOnce() + Send + 'static) -> Result<(), ApiError> {
        self.tx
            .send(Box::new(job))
            .map_err(|_| ApiError::internal("The worker pool has shut down"))
    }
}
