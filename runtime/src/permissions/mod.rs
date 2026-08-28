//! The permission layer.
//!
//! Permissions are compiled once at startup from `vantail.json` and consulted
//! by every native API before it touches the OS. Two rules keep this honest:
//!
//! 1. Everything is denied by default. A capability exists only if the config
//!    asked for it.
//! 2. Path checks run against the *normalised* path, and the handler then
//!    operates on that same normalised path - never on the raw string from
//!    JavaScript. Check and use always agree, so `..` and symlinks cannot
//!    point somewhere the check did not see.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

pub mod network;

use globset::{Glob, GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Deserialize;

use crate::error::ApiError;

// ---------------------------------------------------------------------------
// Config shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionsConfig {
    #[serde(default)]
    pub filesystem: FilesystemConfig,
    #[serde(default)]
    pub dialog: bool,
    #[serde(default)]
    pub clipboard: ClipboardConfig,
    #[serde(default)]
    pub notification: bool,
    #[serde(default = "yes")]
    pub os: bool,
    #[serde(default = "yes")]
    pub window: bool,
    #[serde(default)]
    pub shell: ShellConfig,
    #[serde(default)]
    pub tray: bool,
    #[serde(default)]
    pub shortcut: bool,
    #[serde(default)]
    pub drag_drop: bool,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub menu: bool,
    #[serde(default)]
    pub updater: bool,
    #[serde(default)]
    pub network: network::NetworkConfig,
    /// The OS credential store. Default `false`.
    #[serde(default)]
    pub secrets: bool,
    /// SQLite. Default `false`.
    ///
    /// Where the database may live is still `filesystem.write`, so this is
    /// the capability and that is the reach - the same split every other
    /// path-taking capability has.
    #[serde(default)]
    pub database: bool,
    /// Service types the application may discover. Default: none.
    #[serde(default)]
    pub mdns: TextScopeConfig,
    /// USB HID devices the application may open. Default: none.
    #[serde(default)]
    pub hid: HidConfig,
}

/// `false` | `true` | a list of device rules.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum HidConfig {
    All(bool),
    Devices(Vec<HidRule>),
}

impl Default for HidConfig {
    fn default() -> Self {
        HidConfig::All(false)
    }
}

/// One allowed device, by what the hardware reports about itself.
///
/// Vendor and product ids rather than names, because a name is whatever the
/// device says it is and an id is assigned.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HidRule {
    pub vendor_id: u16,
    /// Any product from that vendor when omitted.
    #[serde(default)]
    pub product_id: Option<u16>,
    /// Narrow further to one HID usage page, e.g. `0xFFA0` for vendor-defined.
    #[serde(default)]
    pub usage_page: Option<u16>,
}

impl HidRule {
    fn matches(&self, vendor_id: u16, product_id: u16, usage_page: u16) -> bool {
        self.vendor_id == vendor_id
            && self
                .product_id
                .is_none_or(|expected| expected == product_id)
            && self
                .usage_page
                .is_none_or(|expected| expected == usage_page)
    }
}

/// Written out rather than derived: `#[serde(default = "...")]` applies when a
/// *field* is missing, and `Default` applies when the whole block is. Deriving
/// `Default` here would silently deny `window` and `os` to any app that omits
/// `permissions` entirely.
impl Default for PermissionsConfig {
    fn default() -> Self {
        Self {
            filesystem: FilesystemConfig::default(),
            dialog: false,
            clipboard: ClipboardConfig::default(),
            notification: false,
            os: true,
            window: true,
            shell: ShellConfig::default(),
            tray: false,
            shortcut: false,
            drag_drop: false,
            autostart: false,
            menu: false,
            updater: false,
            network: network::NetworkConfig::default(),
            secrets: false,
            database: false,
            mdns: TextScopeConfig::default(),
            hid: HidConfig::default(),
        }
    }
}

/// Running other programs.
///
/// There is no shell here and never will be: a program is looked up in the
/// allow list by exact name, and its arguments are passed as a vector. There
/// is no string for a shell to re-parse, so there is nothing to inject into.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellConfig {
    #[serde(default)]
    pub allow: Vec<ShellRule>,
    /// Handing a URL or file to the system's default application.
    #[serde(default)]
    pub open: TextScopeConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellRule {
    /// Exactly what the application must ask for: a bare name resolved on
    /// `PATH`, an absolute path, or a `$RESOURCE`-relative sidecar.
    pub program: String,
    /// Argument rules, one per position. Omit to allow any arguments - which
    /// for most programs is the same as allowing anything at all.
    #[serde(default)]
    pub args: Option<Vec<ArgRule>>,
    /// Directories the program may be run in. Denied unless set.
    #[serde(default)]
    pub cwd: Option<PathScopeConfig>,
}

/// `"status"` for an exact argument, or `{ pattern: "-n*" }` for a glob.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ArgRule {
    Exact(String),
    Pattern { pattern: String },
}

/// `false` | `true` | `["https://*", ...]` - matched against the raw string.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum TextScopeConfig {
    All(bool),
    Patterns(Vec<String>),
}

impl Default for TextScopeConfig {
    fn default() -> Self {
        TextScopeConfig::All(false)
    }
}

/// Glob matching for things that are not paths.
///
/// Unlike [`PathScope`] a `*` here crosses `/`, because the strings being
/// matched are URLs and command arguments rather than filesystem paths.
pub struct TextScope {
    all: bool,
    set: GlobSet,
    patterns: Vec<String>,
}

impl TextScope {
    fn compile(config: &TextScopeConfig) -> Result<Self, String> {
        let (all, patterns) = match config {
            TextScopeConfig::All(all) => (*all, Vec::new()),
            TextScopeConfig::Patterns(patterns) => (false, patterns.clone()),
        };
        Ok(Self {
            all,
            set: build_text_globset(&patterns)?,
            patterns,
        })
    }

    pub fn allows(&self, value: &str) -> bool {
        self.all || self.set.is_match(value)
    }

    pub fn describe(&self) -> String {
        if self.all {
            "anything".to_string()
        } else if self.patterns.is_empty() {
            "nothing".to_string()
        } else {
            self.patterns.join(", ")
        }
    }
}

fn build_text_globset(patterns: &[String]) -> Result<GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(
            GlobBuilder::new(pattern)
                .literal_separator(false)
                .build()
                .map_err(|e| format!("Invalid pattern `{pattern}`: {e}"))?,
        );
    }
    builder.build().map_err(|e| format!("Invalid scope: {e}"))
}

/// One allowed program, compiled.
#[derive(Debug)]
pub struct CompiledRule {
    pub program: String,
    /// `None` means any arguments are acceptable.
    args: Option<Vec<CompiledArg>>,
    cwd: PathScope,
}

#[derive(Debug)]
enum CompiledArg {
    Exact(String),
    Pattern(GlobSet),
}

impl CompiledArg {
    fn allows(&self, value: &str) -> bool {
        match self {
            CompiledArg::Exact(expected) => expected == value,
            CompiledArg::Pattern(set) => set.is_match(value),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilesystemConfig {
    #[serde(default)]
    pub read: PathScopeConfig,
    #[serde(default)]
    pub write: PathScopeConfig,
    /// When the user picks a path in a native dialog, grant access to exactly
    /// that path for the rest of the session. This is what makes a narrow
    /// `read` scope practical: the user's own choice is the grant.
    #[serde(default = "yes")]
    pub grant_from_dialog: bool,
    /// The same, for a path the user dropped on the window. Dropping a file is
    /// the user choosing it just as a dialog is, and without this the paths a
    /// drop reports cannot be opened.
    #[serde(default = "yes")]
    pub grant_from_drop: bool,
}

impl Default for FilesystemConfig {
    fn default() -> Self {
        Self {
            read: PathScopeConfig::default(),
            write: PathScopeConfig::default(),
            grant_from_dialog: true,
            grant_from_drop: true,
        }
    }
}

/// `false` | `true` | `["glob", ...]` | `{ allow: [...], deny: [...] }`
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum PathScopeConfig {
    All(bool),
    Patterns(Vec<String>),
    Detailed {
        #[serde(default)]
        allow: Vec<String>,
        #[serde(default)]
        deny: Vec<String>,
    },
}

impl Default for PathScopeConfig {
    fn default() -> Self {
        PathScopeConfig::All(false)
    }
}

/// `false` | `true` | `{ read: bool, write: bool }`
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ClipboardConfig {
    All(bool),
    Detailed {
        #[serde(default)]
        read: bool,
        #[serde(default)]
        write: bool,
    },
}

impl Default for ClipboardConfig {
    fn default() -> Self {
        ClipboardConfig::All(false)
    }
}

fn yes() -> bool {
    true
}

// ---------------------------------------------------------------------------
// Variable expansion
// ---------------------------------------------------------------------------

/// The `$VARS` usable inside path patterns.
pub struct Vars {
    entries: Vec<(&'static str, PathBuf)>,
}

impl Vars {
    pub fn resolve(identifier: &str, resource_dir: &Path) -> Self {
        let mut entries: Vec<(&'static str, PathBuf)> = Vec::new();
        let mut push = |name: &'static str, value: Option<PathBuf>| {
            if let Some(value) = value {
                entries.push((name, canonical_or_self(&value)));
            }
        };

        push("$HOME", dirs::home_dir());
        push("$DESKTOP", dirs::desktop_dir());
        push("$DOCUMENT", dirs::document_dir());
        push("$DOWNLOAD", dirs::download_dir());
        push("$PICTURE", dirs::picture_dir());
        push("$VIDEO", dirs::video_dir());
        push("$AUDIO", dirs::audio_dir());
        push("$TEMP", Some(std::env::temp_dir()));
        push("$CWD", std::env::current_dir().ok());
        push("$RESOURCE", Some(resource_dir.to_path_buf()));
        push("$APPDATA", dirs::data_dir().map(|d| d.join(identifier)));
        push("$APPCONFIG", dirs::config_dir().map(|d| d.join(identifier)));
        push("$APPCACHE", dirs::cache_dir().map(|d| d.join(identifier)));

        Self { entries }
    }

    pub(crate) fn expand(&self, pattern: &str) -> String {
        let mut out = pattern.to_string();
        for (name, value) in &self.entries {
            if out.contains(name) {
                out = out.replace(name, &value.to_string_lossy());
            }
        }
        out
    }
}

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize()
        .map(|resolved| strip_verbatim(&resolved))
        .unwrap_or_else(|_| path.to_path_buf())
}

// ---------------------------------------------------------------------------
// Compiled permissions
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct PathScope {
    allow_all: bool,
    allow: GlobSet,
    deny: GlobSet,
    /// Kept for error messages, so a denial can say what *was* allowed.
    patterns: Vec<String>,
}

impl PathScope {
    fn compile(config: &PathScopeConfig, vars: &Vars) -> Result<Self, String> {
        let (allow_all, allow_patterns, deny_patterns) = match config {
            PathScopeConfig::All(all) => (*all, Vec::new(), Vec::new()),
            PathScopeConfig::Patterns(patterns) => (false, patterns.clone(), Vec::new()),
            PathScopeConfig::Detailed { allow, deny } => (false, allow.clone(), deny.clone()),
        };

        let expanded: Vec<String> = allow_patterns.iter().map(|p| vars.expand(p)).collect();
        Ok(Self {
            allow_all,
            allow: build_globset(&expanded)?,
            deny: build_globset(
                &deny_patterns
                    .iter()
                    .map(|p| vars.expand(p))
                    .collect::<Vec<_>>(),
            )?,
            patterns: expanded,
        })
    }

    fn is_empty(&self) -> bool {
        !self.allow_all && self.allow.is_empty()
    }

    fn allows(&self, path: &Path) -> bool {
        if self.deny.is_match(path) {
            return false;
        }
        self.allow_all || self.allow.is_match(path)
    }
}

/// `a/b/**` should also match `a/b` itself, otherwise listing the very
/// directory you granted access to fails.
fn build_globset(patterns: &[String]) -> Result<GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let pattern = canonicalize_prefix(pattern);
        builder.add(compile_glob(&pattern)?);
        if let Some(prefix) = pattern.strip_suffix("/**") {
            if !prefix.is_empty() {
                builder.add(compile_glob(prefix)?);
            }
        }
    }
    builder
        .build()
        .map_err(|e| format!("Invalid permission scope: {e}"))
}

/// Resolve the fixed part of a pattern the same way a checked path is
/// resolved.
///
/// Paths arriving from JavaScript are canonicalised before they are matched,
/// so a scope written as `/tmp/**` would otherwise never match anything on
/// macOS, where `/tmp` resolves to `/private/tmp`. Only the leading literal
/// portion is touched; the glob part is left exactly as written.
fn canonicalize_prefix(pattern: &str) -> String {
    let first_meta = pattern.find(['*', '?', '[', '{']).unwrap_or(pattern.len());
    let split = pattern[..first_meta]
        .rfind('/')
        .map_or(0, |index| index + 1);
    if split == 0 {
        return pattern.to_string();
    }

    let (prefix, rest) = pattern.split_at(split);
    let literal = Path::new(prefix.trim_end_matches('/'));

    // Only absolute prefixes: resolving a relative one against the current
    // directory would make a scope mean different things depending on where
    // the application happened to be launched from.
    if !literal.is_absolute() {
        return pattern.to_string();
    }

    // `normalize` resolves as much of the path as exists and keeps the rest,
    // so `/tmp/not-created-yet/**` still lands on `/private/tmp/...`.
    let Ok(resolved) = normalize(literal) else {
        return pattern.to_string();
    };

    let mut out = display_pattern(&strip_verbatim(&resolved));
    if out.ends_with('/') {
        out.pop();
    }
    out.push('/');
    out.push_str(rest);
    out
}

/// A canonical path as a glob pattern: forward slashes, and without the
/// Windows verbatim prefix that `canonicalize` adds.
fn display_pattern(path: &Path) -> String {
    let text = path.to_string_lossy();
    let trimmed = text.strip_prefix(r"\\?\").unwrap_or(&text);
    trimmed.replace('\\', "/")
}

fn compile_glob(pattern: &str) -> Result<Glob, String> {
    GlobBuilder::new(pattern)
        // Without this a single `*` happily matches across directories, so
        // `~/public/*` would also allow `~/public/private/keys`. A scope has
        // to mean exactly what it looks like it means.
        .literal_separator(true)
        .build()
        .map_err(|e| format!("Invalid permission pattern `{pattern}`: {e}"))
}

#[derive(Default)]
struct Grants {
    read: HashSet<PathBuf>,
    write: HashSet<PathBuf>,
}

pub struct Permissions {
    fs_read: PathScope,
    fs_write: PathScope,
    shell: Vec<CompiledRule>,
    shell_open: TextScope,
    grant_from_dialog: bool,
    grant_from_drop: bool,
    pub dialog: bool,
    pub clipboard_read: bool,
    pub clipboard_write: bool,
    pub notification: bool,
    pub os: bool,
    pub window: bool,
    pub tray: bool,
    pub shortcut: bool,
    pub drag_drop: bool,
    pub autostart: bool,
    pub menu: bool,
    pub updater: bool,
    pub network: network::NetworkScope,
    pub secrets: bool,
    pub database: bool,
    mdns: TextScope,
    hid: HidConfig,
    granted: Mutex<Grants>,
}

/// Which side of the filesystem a check is for.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

impl Access {
    fn label(self) -> &'static str {
        match self {
            Access::Read => "filesystem.read",
            Access::Write => "filesystem.write",
        }
    }
}

impl Permissions {
    pub fn compile(config: &PermissionsConfig, vars: &Vars) -> Result<Self, String> {
        let (clipboard_read, clipboard_write) = match &config.clipboard {
            ClipboardConfig::All(all) => (*all, *all),
            ClipboardConfig::Detailed { read, write } => (*read, *write),
        };

        let mut shell = Vec::with_capacity(config.shell.allow.len());
        for rule in &config.shell.allow {
            shell.push(CompiledRule {
                program: rule.program.clone(),
                args: rule
                    .args
                    .as_ref()
                    .map(|args| compile_args(args))
                    .transpose()?,
                cwd: PathScope::compile(
                    rule.cwd.as_ref().unwrap_or(&PathScopeConfig::All(false)),
                    vars,
                )?,
            });
        }

        Ok(Self {
            fs_read: PathScope::compile(&config.filesystem.read, vars)?,
            fs_write: PathScope::compile(&config.filesystem.write, vars)?,
            shell,
            shell_open: TextScope::compile(&config.shell.open)?,
            grant_from_dialog: config.filesystem.grant_from_dialog,
            grant_from_drop: config.filesystem.grant_from_drop,
            dialog: config.dialog,
            clipboard_read,
            clipboard_write,
            notification: config.notification,
            os: config.os,
            window: config.window,
            tray: config.tray,
            shortcut: config.shortcut,
            drag_drop: config.drag_drop,
            autostart: config.autostart,
            menu: config.menu,
            updater: config.updater,
            network: network::NetworkScope::compile(&config.network, vars)?,
            secrets: config.secrets,
            database: config.database,
            mdns: TextScope::compile(&config.mdns)?,
            hid: config.hid.clone(),
            granted: Mutex::new(Grants::default()),
        })
    }

    pub fn require(&self, allowed: bool, capability: &str) -> Result<(), ApiError> {
        if allowed {
            Ok(())
        } else {
            Err(ApiError::denied(format!(
                "`{capability}` is not allowed. Add it to `permissions` in vantail.config.ts."
            )))
        }
    }

    /// Normalise `raw` and check it against the scope for `access`.
    ///
    /// Returns the normalised path; callers must use it for the actual
    /// operation so that what was checked is what gets touched.
    pub fn check_path(&self, raw: &str, access: Access) -> Result<PathBuf, ApiError> {
        let path = normalize(Path::new(raw))?;

        if self.granted_contains(&path, access) {
            return Ok(path);
        }

        let scope = match access {
            Access::Read => &self.fs_read,
            Access::Write => &self.fs_write,
        };

        if scope.allows(&path) {
            return Ok(path);
        }

        let label = access.label();
        let detail = if scope.is_empty() {
            format!("`{label}` is not enabled")
        } else {
            format!("`{label}` is not allowed for {}", path.display())
        };
        Err(
            ApiError::denied(format!("{detail}. Allowed: {}", describe(scope)))
                .with_data(serde_json::json!({ "path": path, "access": label })),
        )
    }

    fn granted_contains(&self, path: &Path, access: Access) -> bool {
        let grants = self.granted.lock().expect("permission grants poisoned");
        let set = match access {
            Access::Read => &grants.read,
            Access::Write => &grants.write,
        };
        // A granted directory covers everything under it, so an open-directory
        // dialog behaves the way a user expects.
        set.iter()
            .any(|granted| path == granted || path.starts_with(granted))
    }

    /// Check a program and its arguments against the allow list.
    ///
    /// Returns the matching rule so the caller can also validate the working
    /// directory against the scope that rule carries.
    pub fn check_program(&self, program: &str, args: &[String]) -> Result<&CompiledRule, ApiError> {
        let Some(rule) = self.shell.iter().find(|rule| rule.program == program) else {
            let known: Vec<&str> = self.shell.iter().map(|r| r.program.as_str()).collect();
            return Err(ApiError::denied(format!(
                "`{program}` is not in `permissions.shell.allow`. Allowed: {}",
                if known.is_empty() {
                    "nothing".to_string()
                } else {
                    known.join(", ")
                }
            )));
        };

        let Some(expected) = &rule.args else {
            return Ok(rule);
        };

        if expected.len() != args.len() {
            return Err(ApiError::denied(format!(
                "`{program}` is allowed with {} argument(s), not {}",
                expected.len(),
                args.len()
            )));
        }
        for (index, (rule_arg, value)) in expected.iter().zip(args).enumerate() {
            if !rule_arg.allows(value) {
                return Err(ApiError::denied(format!(
                    "Argument {index} of `{program}` is not allowed: `{value}`"
                )));
            }
        }

        Ok(rule)
    }

    /// Check a working directory against the rule that permitted the program.
    pub fn check_cwd(&self, rule: &CompiledRule, raw: &str) -> Result<PathBuf, ApiError> {
        let path = normalize(Path::new(raw))?;
        if rule.cwd.allows(&path) {
            return Ok(path);
        }
        Err(ApiError::denied(format!(
            "`{}` may not run in {}. Allowed: {}",
            rule.program,
            path.display(),
            describe(&rule.cwd)
        )))
    }

    /// Whether a service type may be discovered.
    ///
    /// Scoped by type because "find me the lights" and "enumerate everything
    /// on this network" are different requests, and only one of them is what
    /// an application usually means.
    pub fn check_service(&self, service: &str) -> Result<(), ApiError> {
        // Rules are written without the trailing dot; the resolver wants one.
        let bare = service.trim_end_matches('.');
        if self.mdns.allows(bare) || self.mdns.allows(service) {
            return Ok(());
        }
        Err(ApiError::denied(format!(
            "`{bare}` is not in `permissions.mdns`. Allowed: {}",
            self.mdns.describe()
        )))
    }

    /// Whether a device may be opened, by what it reports about itself.
    pub fn allows_device(&self, vendor_id: u16, product_id: u16, usage_page: u16) -> bool {
        match &self.hid {
            HidConfig::All(all) => *all,
            HidConfig::Devices(rules) => rules
                .iter()
                .any(|rule| rule.matches(vendor_id, product_id, usage_page)),
        }
    }

    pub fn check_device(
        &self,
        vendor_id: u16,
        product_id: u16,
        usage_page: u16,
    ) -> Result<(), ApiError> {
        if self.allows_device(vendor_id, product_id, usage_page) {
            return Ok(());
        }
        Err(ApiError::denied(format!(
            "HID device {vendor_id:#06x}:{product_id:#06x} is not in `permissions.hid`. Allowed: {}",
            describe_hid(&self.hid)
        )))
    }

    pub fn check_open(&self, target: &str) -> Result<(), ApiError> {
        if self.shell_open.allows(target) {
            return Ok(());
        }
        Err(ApiError::denied(format!(
            "`shell.open` is not allowed for `{target}`. Allowed: {}",
            self.shell_open.describe()
        )))
    }

    /// Record a path the user chose in a native dialog.
    /// A dropped path, granted for the session.
    ///
    /// Read only: dropping a file on a window says "look at this", not "you
    /// may overwrite it".
    pub fn grant_from_drop(&self, path: &Path) {
        if !self.grant_from_drop {
            return;
        }
        // Through the same normalisation a check uses. A grant stored under a
        // different spelling of the same file is no grant at all - /tmp and
        // /private/tmp being the obvious way to get that wrong.
        let Ok(path) = normalize(path) else {
            return;
        };
        self.granted
            .lock()
            .expect("permission grants poisoned")
            .read
            .insert(path);
    }

    pub fn grant_from_dialog(&self, path: &Path, access: Access) {
        if !self.grant_from_dialog {
            return;
        }
        // Through the same normalisation a check uses, or the grant is stored
        // under a spelling no check will look up. macOS dialogs happen to hand
        // back resolved paths, which is why this went unnoticed.
        let Ok(path) = normalize(path) else {
            return;
        };

        let mut grants = self.granted.lock().expect("permission grants poisoned");
        match access {
            Access::Read => {
                grants.read.insert(path);
            }
            Access::Write => {
                // Saving a file implies being able to read it back.
                grants.write.insert(path.clone());
                grants.read.insert(path);
            }
        }
    }
}

fn compile_args(args: &[ArgRule]) -> Result<Vec<CompiledArg>, String> {
    args.iter()
        .map(|arg| match arg {
            ArgRule::Exact(value) => Ok(CompiledArg::Exact(value.clone())),
            ArgRule::Pattern { pattern } => {
                build_text_globset(std::slice::from_ref(pattern)).map(CompiledArg::Pattern)
            }
        })
        .collect()
}

fn describe_hid(config: &HidConfig) -> String {
    match config {
        HidConfig::All(true) => "every device".to_string(),
        HidConfig::All(false) => "nothing".to_string(),
        HidConfig::Devices(rules) if rules.is_empty() => "nothing".to_string(),
        HidConfig::Devices(rules) => rules
            .iter()
            .map(|rule| match rule.product_id {
                Some(product) => format!("{:#06x}:{product:#06x}", rule.vendor_id),
                None => format!("{:#06x}:*", rule.vendor_id),
            })
            .collect::<Vec<_>>()
            .join(", "),
    }
}

fn describe(scope: &PathScope) -> String {
    if scope.allow_all {
        "everything".to_string()
    } else if scope.patterns.is_empty() {
        "nothing".to_string()
    } else {
        scope.patterns.join(", ")
    }
}

/// Turn a caller-supplied path into an absolute, symlink-resolved path.
///
/// The path need not exist: the deepest existing ancestor is canonicalised and
/// the remaining components appended. `..` is resolved lexically first, so it
/// can never survive into the returned path.
pub fn normalize(path: &Path) -> Result<PathBuf, ApiError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| ApiError::io("Could not resolve the current directory", e))?
            .join(path)
    };

    let mut cleaned = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !cleaned.pop() {
                    return Err(ApiError::invalid_params(format!(
                        "Path escapes the filesystem root: {}",
                        path.display()
                    )));
                }
            }
            other => cleaned.push(other.as_os_str()),
        }
    }

    // Canonicalise as much of the path as actually exists.
    let mut existing = cleaned.as_path();
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if existing.exists() {
            break;
        }
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                existing = parent;
            }
            _ => break,
        }
    }

    let canonical = existing
        .canonicalize()
        .unwrap_or_else(|_| existing.to_path_buf());
    let mut resolved = strip_verbatim(&canonical);
    for name in tail.iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

/// Undo Windows' verbatim path prefix.
///
/// `canonicalize` returns verbatim paths on Windows, and a scope pattern
/// written the ordinary way will never match one. Both sides of the
/// comparison go through this, so both agree.
///
/// A no-op everywhere else.
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();

    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        // A verbatim UNC path is really a plain server-and-share path.
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }

    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> Vars {
        Vars::resolve("dev.vantail.test", Path::new("/tmp"))
    }

    fn scope(config: PathScopeConfig) -> PathScope {
        PathScope::compile(&config, &vars()).expect("scope compiles")
    }

    fn permissions(config: PermissionsConfig) -> Permissions {
        Permissions::compile(&config, &vars()).expect("permissions compile")
    }

    fn temp_dir() -> PathBuf {
        canonical_or_self(&std::env::temp_dir())
    }

    #[test]
    fn normalize_resolves_parent_segments() {
        let base = temp_dir();
        let path = base.join("a/b/../c/./d.txt");
        assert_eq!(normalize(&path).unwrap(), base.join("a/c/d.txt"));
    }

    #[test]
    fn normalize_rejects_escaping_the_root() {
        assert!(normalize(Path::new("/../../../etc/passwd")).is_err());
    }

    #[test]
    fn normalize_keeps_paths_that_do_not_exist_yet() {
        let path = temp_dir().join("vantail-does-not-exist/nested/file.txt");
        assert_eq!(normalize(&path).unwrap(), path);
    }

    #[test]
    fn a_traversing_path_cannot_reach_outside_an_allowed_scope() {
        let base = temp_dir();
        let permissions = permissions(PermissionsConfig {
            filesystem: FilesystemConfig {
                read: PathScopeConfig::Patterns(vec![format!("{}/allowed/**", base.display())]),
                ..FilesystemConfig::default()
            },
            ..PermissionsConfig::default()
        });

        let inside = format!("{}/allowed/notes.txt", base.display());
        assert!(permissions.check_path(&inside, Access::Read).is_ok());

        let escape = format!("{}/allowed/../secret.txt", base.display());
        let error = permissions.check_path(&escape, Access::Read).unwrap_err();
        assert_eq!(error.code, crate::error::code::PERMISSION_DENIED);
    }

    #[test]
    fn check_path_returns_the_path_the_caller_should_use() {
        let base = temp_dir();
        let permissions = permissions(PermissionsConfig {
            filesystem: FilesystemConfig {
                read: PathScopeConfig::All(true),
                ..FilesystemConfig::default()
            },
            ..PermissionsConfig::default()
        });

        // What the check validated and what the handler opens must be the
        // same path, or the check means nothing.
        let raw = format!("{}/x/../y.txt", base.display());
        assert_eq!(
            permissions.check_path(&raw, Access::Read).unwrap(),
            base.join("y.txt")
        );
    }

    #[test]
    fn deny_beats_allow() {
        let scope = scope(PathScopeConfig::Detailed {
            allow: vec!["/data/**".into()],
            deny: vec!["/data/secrets/**".into()],
        });

        assert!(scope.allows(Path::new("/data/public/a.txt")));
        assert!(!scope.allows(Path::new("/data/secrets/a.txt")));
    }

    #[test]
    fn a_recursive_pattern_also_matches_the_directory_itself() {
        // Otherwise `readDir` on the very directory you granted would fail.
        let scope = scope(PathScopeConfig::Patterns(vec!["/data/**".into()]));
        assert!(scope.allows(Path::new("/data")));
        assert!(scope.allows(Path::new("/data/nested/deep.txt")));
        assert!(!scope.allows(Path::new("/database")));
    }

    #[test]
    fn a_single_star_does_not_cross_directories() {
        let scope = scope(PathScopeConfig::Patterns(vec!["/data/*.txt".into()]));
        assert!(scope.allows(Path::new("/data/a.txt")));
        assert!(!scope.allows(Path::new("/data/nested/a.txt")));
    }

    #[test]
    fn nothing_is_allowed_by_default() {
        let permissions = permissions(PermissionsConfig::default());
        let base = temp_dir();

        assert!(permissions
            .check_path(&format!("{}/a.txt", base.display()), Access::Read)
            .is_err());
        assert!(!permissions.dialog);
        assert!(!permissions.clipboard_read);
        assert!(!permissions.notification);
        // Reading the app's own window and platform is not a privilege.
        assert!(permissions.os);
        assert!(permissions.window);
    }

    #[test]
    fn a_dialog_grant_opens_exactly_what_the_user_picked() {
        let base = temp_dir();
        let permissions = permissions(PermissionsConfig::default());
        let picked = base.join("chosen.txt");
        let sibling = base.join("not-chosen.txt");

        assert!(permissions
            .check_path(&picked.to_string_lossy(), Access::Read)
            .is_err());

        permissions.grant_from_dialog(&picked, Access::Read);

        assert!(permissions
            .check_path(&picked.to_string_lossy(), Access::Read)
            .is_ok());
        assert!(permissions
            .check_path(&sibling.to_string_lossy(), Access::Read)
            .is_err());
        // A read grant is not a write grant.
        assert!(permissions
            .check_path(&picked.to_string_lossy(), Access::Write)
            .is_err());
    }

    #[test]
    fn a_granted_directory_covers_its_contents() {
        let base = temp_dir();
        let permissions = permissions(PermissionsConfig::default());
        let directory = base.join("picked-folder");

        permissions.grant_from_dialog(&directory, Access::Read);

        assert!(permissions
            .check_path(
                &directory.join("inside.txt").to_string_lossy(),
                Access::Read
            )
            .is_ok());
    }

    #[test]
    fn dialog_grants_can_be_switched_off() {
        let base = temp_dir();
        let permissions = permissions(PermissionsConfig {
            filesystem: FilesystemConfig {
                grant_from_dialog: false,
                ..FilesystemConfig::default()
            },
            ..PermissionsConfig::default()
        });
        let picked = base.join("chosen.txt");

        permissions.grant_from_dialog(&picked, Access::Read);
        assert!(permissions
            .check_path(&picked.to_string_lossy(), Access::Read)
            .is_err());
    }

    #[test]
    fn saving_a_file_also_lets_the_app_read_it_back() {
        let base = temp_dir();
        let permissions = permissions(PermissionsConfig::default());
        let picked = base.join("saved.txt");

        permissions.grant_from_dialog(&picked, Access::Write);

        assert!(permissions
            .check_path(&picked.to_string_lossy(), Access::Write)
            .is_ok());
        assert!(permissions
            .check_path(&picked.to_string_lossy(), Access::Read)
            .is_ok());
    }

    #[test]
    fn clipboard_read_and_write_are_separate() {
        let permissions = permissions(PermissionsConfig {
            clipboard: ClipboardConfig::Detailed {
                read: false,
                write: true,
            },
            ..PermissionsConfig::default()
        });

        assert!(!permissions.clipboard_read);
        assert!(permissions.clipboard_write);
    }

    #[test]
    fn windows_verbatim_paths_are_reduced_to_ordinary_ones() {
        // `canonicalize` hands back a verbatim path on Windows. A scope
        // written the ordinary way would never match one, so both sides are
        // reduced before they meet.
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\C:\Users\me")),
            PathBuf::from(r"C:\Users\me")
        );
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\server\share\file")),
            PathBuf::from(r"\\server\share\file")
        );
        // Anything else is left exactly as it was.
        assert_eq!(
            strip_verbatim(Path::new("/usr/local")),
            PathBuf::from("/usr/local")
        );
    }

    #[test]
    fn a_scope_written_through_a_symlink_still_matches() {
        // `std::env::temp_dir()` is `/var/folders/...` on macOS, while a
        // checked path resolves to `/private/var/folders/...`. A config that
        // names the first must still allow the second.
        let raw = std::env::temp_dir();
        let permissions = permissions(PermissionsConfig {
            filesystem: FilesystemConfig {
                read: PathScopeConfig::Patterns(vec![format!(
                    "{}/**",
                    raw.to_string_lossy().trim_end_matches('/')
                )]),
                ..FilesystemConfig::default()
            },
            ..PermissionsConfig::default()
        });

        let target = raw.join("vantail-symlink-scope.txt");
        assert!(permissions
            .check_path(&target.to_string_lossy(), Access::Read)
            .is_ok());
    }

    #[test]
    fn a_pattern_naming_a_directory_that_does_not_exist_is_kept_as_written() {
        let scope = scope(PathScopeConfig::Patterns(vec![
            "/definitely/not/here/**".into()
        ]));
        assert!(scope.allows(Path::new("/definitely/not/here/file.txt")));
        assert!(!scope.allows(Path::new("/somewhere/else/file.txt")));
    }

    #[test]
    fn variables_expand_inside_patterns() {
        let expanded = vars().expand("$TEMP/logs/**");
        assert!(expanded.starts_with(&temp_dir().to_string_lossy().to_string()));
        assert!(expanded.ends_with("/logs/**"));
    }
}

#[cfg(test)]
mod shell_tests {
    use super::tests_support::*;
    use super::*;

    fn shell(config: ShellConfig) -> Permissions {
        permissions_with(PermissionsConfig {
            shell: config,
            ..PermissionsConfig::default()
        })
    }

    fn rule(program: &str, args: Option<Vec<ArgRule>>) -> ShellRule {
        ShellRule {
            program: program.into(),
            args,
            cwd: None,
        }
    }

    #[test]
    fn a_program_that_is_not_listed_is_refused() {
        let permissions = shell(ShellConfig::default());
        let error = permissions.check_program("git", &[]).unwrap_err();
        assert_eq!(error.code, crate::error::code::PERMISSION_DENIED);
        assert!(error.message.contains("Allowed: nothing"));
    }

    #[test]
    fn a_listed_program_with_no_arg_rules_takes_any_arguments() {
        let permissions = shell(ShellConfig {
            allow: vec![rule("git", None)],
            ..ShellConfig::default()
        });
        assert!(permissions.check_program("git", &[]).is_ok());
        assert!(permissions
            .check_program("git", &["push".into(), "--force".into()])
            .is_ok());
    }

    #[test]
    fn arg_rules_pin_both_the_values_and_how_many_there_are() {
        let permissions = shell(ShellConfig {
            allow: vec![rule(
                "git",
                Some(vec![
                    ArgRule::Exact("status".into()),
                    ArgRule::Exact("--porcelain".into()),
                ]),
            )],
            ..ShellConfig::default()
        });

        assert!(permissions
            .check_program("git", &["status".into(), "--porcelain".into()])
            .is_ok());
        // Right values, wrong count.
        assert!(permissions
            .check_program("git", &["status".into()])
            .is_err());
        // Right count, wrong value - this is the one that matters.
        assert!(permissions
            .check_program("git", &["push".into(), "--porcelain".into()])
            .is_err());
    }

    #[test]
    fn a_pattern_constrains_one_argument_position() {
        let permissions = shell(ShellConfig {
            allow: vec![rule(
                "git",
                Some(vec![
                    ArgRule::Exact("log".into()),
                    ArgRule::Pattern {
                        pattern: "-n*".into(),
                    },
                ]),
            )],
            ..ShellConfig::default()
        });

        assert!(permissions
            .check_program("git", &["log".into(), "-n10".into()])
            .is_ok());
        assert!(permissions
            .check_program("git", &["log".into(), "--all".into()])
            .is_err());
    }

    #[test]
    fn an_empty_arg_list_means_no_arguments_at_all() {
        let permissions = shell(ShellConfig {
            allow: vec![rule("true", Some(vec![]))],
            ..ShellConfig::default()
        });
        assert!(permissions.check_program("true", &[]).is_ok());
        assert!(permissions.check_program("true", &["x".into()]).is_err());
    }

    #[test]
    fn a_working_directory_is_denied_unless_the_rule_allows_it() {
        let base = std::env::temp_dir();
        let permissions = shell(ShellConfig {
            allow: vec![ShellRule {
                program: "ls".into(),
                args: None,
                cwd: Some(PathScopeConfig::Patterns(vec![format!(
                    "{}/allowed/**",
                    base.to_string_lossy().trim_end_matches('/')
                )])),
            }],
            ..ShellConfig::default()
        });

        let rule = permissions
            .check_program("ls", &[])
            .expect("program allowed");
        assert!(permissions
            .check_cwd(rule, &base.join("allowed/here").to_string_lossy())
            .is_ok());
        assert!(permissions
            .check_cwd(rule, &base.join("elsewhere").to_string_lossy())
            .is_err());
    }

    #[test]
    fn shell_open_is_denied_by_default_and_scoped_when_enabled() {
        assert!(shell(ShellConfig::default())
            .check_open("https://example.com")
            .is_err());

        let permissions = shell(ShellConfig {
            open: TextScopeConfig::Patterns(vec!["https://*".into()]),
            ..ShellConfig::default()
        });
        // `*` crosses `/` here, because these are URLs rather than paths.
        assert!(permissions.check_open("https://example.com/a/b").is_ok());
        assert!(permissions.check_open("file:///etc/passwd").is_err());
        assert!(permissions
            .check_open("/Applications/Calculator.app")
            .is_err());
    }
}

#[cfg(test)]
mod tests_support {
    use super::*;

    pub fn permissions_with(config: PermissionsConfig) -> Permissions {
        let vars = Vars::resolve("dev.vantail.test", Path::new("/tmp"));
        Permissions::compile(&config, &vars).expect("permissions compile")
    }
}

#[cfg(test)]
mod drop_grant_tests {
    use super::*;

    fn permissions(grant_from_drop: bool) -> Permissions {
        let mut config = PermissionsConfig::default();
        config.filesystem.grant_from_drop = grant_from_drop;
        super::tests_support::permissions_with(config)
    }

    #[test]
    fn a_dropped_path_becomes_readable() {
        let permissions = permissions(true);
        let dropped = Path::new("/tmp/dropped.txt");

        // Nothing in the config mentions it.
        assert!(permissions
            .check_path("/tmp/dropped.txt", Access::Read)
            .is_err());

        permissions.grant_from_drop(dropped);
        assert!(permissions
            .check_path("/tmp/dropped.txt", Access::Read)
            .is_ok());
    }

    #[test]
    fn a_dropped_path_does_not_become_writable() {
        // Dropping a file on a window says look at this, not overwrite this.
        let permissions = permissions(true);
        permissions.grant_from_drop(Path::new("/tmp/dropped.txt"));
        assert!(permissions
            .check_path("/tmp/dropped.txt", Access::Write)
            .is_err());
    }

    #[test]
    fn a_grant_is_found_under_another_spelling_of_the_same_path() {
        // /tmp is a symlink to /private/tmp on macOS, so a grant recorded
        // under one and looked up under the other has to still match.
        let permissions = permissions(true);
        permissions.grant_from_drop(Path::new("/tmp/./sub/../spelled.txt"));
        assert!(permissions
            .check_path("/tmp/spelled.txt", Access::Read)
            .is_ok());
    }

    #[test]
    fn the_grant_can_be_switched_off() {
        let permissions = permissions(false);
        permissions.grant_from_drop(Path::new("/tmp/dropped.txt"));
        assert!(permissions
            .check_path("/tmp/dropped.txt", Access::Read)
            .is_err());
    }
}
