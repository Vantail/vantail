# Rust guidelines

The runtime should read like plain, explicit code: short functions, shallow
nesting, failure handled where it happens. Someone who knows Java or C# but not
idiomatic Rust should be able to follow a function top to bottom without
holding much in their head. Where a terse Rust idiom and an explicit version
say the same thing, the explicit version wins.

None of this weakens what Rust checks. The borrow checker and the type system
stay exactly as strict; what is restricted is style.

Rules the compiler or clippy can check are lints in the root
[`Cargo.toml`](../Cargo.toml), so `cargo clippy` fails on them locally the same
way CI does. A lint is only switched on once the code already passes it, so the
table only ever gets stricter. The rest are conventions, for reviewers.

## Enforced

### `unsafe` says why it is sound

The runtime cannot do without `unsafe`: the custom title bar, window shapes,
menus, printing, power notifications and the permission prompts are calls into
AppKit and Win32 that Rust cannot check. So `unsafe` is allowed, but only for
calls into the OS, and never without a reason written next to it.

- **Every `unsafe` block has a `// Safety:` comment** directly above it,
  saying what makes it sound: whose pointer it is, why it is still alive, which
  thread this runs on. `clippy::undocumented_unsafe_blocks`.
- **An `unsafe fn` documents its contract** in a `# Safety` section - what the
  caller has to guarantee - and each unsafe operation inside it still gets its
  own block and comment. `unsafe_op_in_unsafe_fn`.

```rust
/// # Safety
///
/// `layer` must be a live `CALayer`, and this must run on the main thread.
unsafe fn apply_shape(layer: *mut AnyObject, radii: Radii) {
    // Safety: `layer` is a live `CALayer`, as the caller guarantees.
    let bounds: NSRect = unsafe { msg_send![layer, bounds] };
    // ...
}
```

### No `unwrap()`

`clippy::unwrap_used`. A panic should be a decision someone wrote down, not a
default. Handle the `None` or the `Err`; if it truly cannot happen, `expect`
with a message saying why. Tests may unwrap - a test that panics is a test that
fails, which is what it is for - so `clippy.toml` exempts them.

## Conventions

These are not checked, but are expected in review.

- **Comments say why**, as everywhere in this repository. See
  [CONTRIBUTING.md](../CONTRIBUTING.md#ways-of-working).
- **An `#[allow(...)]` carries a comment** saying why the lint is wrong here.
  A lint is never silenced for a whole file or crate to get past it.

## Planned

Each of these lands as its own change, with the code brought into line first
and the lint switched on in the same commit.

1. **Short functions, shallow nesting.** At most 60 lines a function
   (`too_many_lines`), 4 levels of nesting (`excessive_nesting`) and 6
   arguments (`too_many_arguments`). This is where most of the effort of
   reading the runtime goes today: the event loop and the window dispatcher
   are each over 200 lines.
2. **Failure handled explicitly.** No slice indexing that can panic
   (`indexing_slicing`) - use `.get()` and handle the `None`. No `expect`
   (`expect_used`); the one place it is genuinely the right answer, taking a
   lock, goes through a single documented helper.
3. **Plain control flow.** `for` loops instead of iterator chains
   (`map`, `filter`, `collect`, `any`, `find`, ... through `disallowed-methods`),
   and `match` or `if let` instead of `Option` and `Result` chains such as
   `.and_then(...).unwrap_or_else(...)`. `map_err` followed by `?` stays: it
   is the plain way to say "fail with this error".
4. **Formatting at 80 columns.** Last, in one change, when no other branch is
   open, and listed in `.git-blame-ignore-revs` so `git blame` looks past it.

Two things were considered and left out:

- **`clippy::implicit_return`**, which would put `return` in front of the last
  expression of every function and closure. It would add over a thousand
  `return`s that tell the reader nothing.
- **`forbid(unsafe_code)`**, which is not possible while the window chrome and
  the permission prompts are OS calls. The `Safety` rules above are what is
  enforced instead.
