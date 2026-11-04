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

### Failure handled where it happens

No `unwrap()`, no `expect()`, and no indexing or slicing that can panic
(`clippy::unwrap_used`, `clippy::expect_used`, `clippy::indexing_slicing`). A
release build aborts on a panic, so one in any thread takes the whole
application down. Handle the `None` or the `Err` where it arises, and say in
the code what happens then:

- **An index** becomes `.get()`, with the missing case handled. A slice
  pattern (`[value, alpha]`) reads better than two indexes.
- **The bytes a read filled** are `crate::read::filled(&buffer, count)`, not
  `&buffer[..count]`.
- **A lock** is `crate::lock::lock(&mutex)`, which takes the lock even if
  another thread panicked holding it, instead of `.lock().expect(...)`.
- **A value created on first use** is taken out of its slot and put back with
  `Option::insert`, so there is no "just created" case to assert.
- **Something that would mean the platform changed under us** - an OS
  constant that is missing, say - fails closed instead of panicking.

Something that truly cannot happen, and cannot be written so that it does not
need saying, keeps its `expect` under an `#[allow(clippy::expect_used)]` with
the reason beside it. `WindowConfig::default` is the one: it parses `{}` so the
defaults live only in the serde attributes.

Tests may unwrap, expect and index - a test that panics is a test that fails,
which is what it is for - so `clippy.toml` exempts them.

### Short functions, shallow nesting, few arguments

At most 60 lines a function, 4 levels of nesting and 6 arguments
(`clippy::too_many_lines`, `clippy::excessive_nesting`,
`clippy::too_many_arguments`; the limits are in `clippy.toml`). Past those a
function is usually doing more than one thing. The ways the runtime stays
under them:

- **A dispatcher is a table.** One line per method in the `match`, naming the
  function that does the work. What used to be a comment on the arm is the
  doc comment on that function.
- **A long sequence becomes named steps**, called in the same order, so the
  function that calls them reads as a list of what happens.
- **Values that travel together become a struct** - a database `Target`, an
  `Outbound` request - rather than a longer argument list.
- **Return early** with `let ... else` or `if ... { return }` instead of
  nesting the rest of the function inside a condition.

A function that is right to be long says so: the bridge's JavaScript is one
template whose parts share variables, so `init_script` carries an
`#[allow(clippy::too_many_lines)]` with the reason beside it.

## Platform-only code

Clippy only sees the code for the platform it runs on, and CI lints on Linux.
Code behind `#[cfg(target_os = "windows")]` or `"macos"` is not linted there,
so check it where it compiles. Windows can be checked from another machine,
without the C dependencies that need a Windows compiler:

```bash
rustup target add x86_64-pc-windows-msvc
cargo clippy --target x86_64-pc-windows-msvc --no-default-features --all-targets
```

## Conventions

These are not checked, but are expected in review.

- **Comments say why**, as everywhere in this repository. See
  [CONTRIBUTING.md](../CONTRIBUTING.md#ways-of-working).
- **An `#[allow(...)]` carries a comment** saying why the lint is wrong here.
  A lint is never silenced for a whole file or crate to get past it.

## Planned

Each of these lands as its own change: the code brought into line first, then
the lint switched on once nothing trips it.

1. **Plain control flow.** `for` loops instead of iterator chains
   (`map`, `filter`, `collect`, `any`, `find`, ... through `disallowed-methods`),
   and `match` or `if let` instead of `Option` and `Result` chains such as
   `.and_then(...).unwrap_or_else(...)`. `map_err` followed by `?` stays: it
   is the plain way to say "fail with this error".
2. **Formatting at 80 columns.** Last, in one change, when no other branch is
   open, and listed in `.git-blame-ignore-revs` so `git blame` looks past it.

Two things were considered and left out:

- **`clippy::implicit_return`**, which would put `return` in front of the last
  expression of every function and closure. It would add over a thousand
  `return`s that tell the reader nothing.
- **`forbid(unsafe_code)`**, which is not possible while the window chrome and
  the permission prompts are OS calls. The `Safety` rules above are what is
  enforced instead.
