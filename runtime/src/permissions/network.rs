//! Which hosts an application may talk to.
//!
//! This exists because the webview's own `fetch` cannot reach most local
//! hardware: a smart-home hub serves HTTPS with a self-signed certificate, and
//! nothing on the LAN sends the CORS headers a webview insists on. So the
//! runtime has to make those requests - and the moment it does, "which hosts"
//! stops being the browser's problem and becomes ours.
//!
//! Rules are deliberately few and unambiguous:
//!
//! | Rule                      | Matches                                    |
//! | ------------------------- | ------------------------------------------ |
//! | `api.example.com`           | that host exactly, any scheme, any port    |
//! | `*.example.com`             | any host *under* it - not the apex         |
//! | `*`                       | every host                                 |
//! | `192.168.0.0/16`          | any address in that range                  |
//! | `http://192.168.1.50`     | that scheme and host, any port             |
//! | `http://192.168.1.50:80`  | that scheme, host and port                 |

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;

use crate::error::ApiError;
use crate::permissions::Vars;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkConfig {
    /// Hosts, ranges or origins the application may reach. Empty denies all.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Checked first, and wins.
    #[serde(default)]
    pub deny: Vec<String>,
    /// Hosts whose TLS certificate does not have to be trusted.
    ///
    /// Separate from `allow` because "may talk to" and "may talk to without
    /// verifying who is answering" are different decisions, and the second
    /// should have to be made on purpose.
    #[serde(default)]
    pub allow_invalid_certificates: Vec<String>,
    /// Client certificates to present, and which hosts to present them to.
    ///
    /// Here rather than in the call for the same reason every other path is:
    /// an application cannot reach a file the config did not name, and a
    /// reviewer reading this file can see every key the application can use.
    #[serde(default)]
    pub client_certificates: Vec<ClientCertificateConfig>,
    /// Send requests through a proxy.
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
    /// Ask the user about a host that is not in `allow`, rather than refusing
    /// it outright.
    ///
    /// For the applications this runtime is mostly for - one that talks to a
    /// hub, or to a service you already know - a static list is exactly right
    /// and the discipline is the feature. This is for the other kind: an API
    /// client, a webhook inspector, a link checker, anything whose whole job
    /// is a host the *user* names. `allow: ["*"]` is the blunt answer; this
    /// is the narrow one.
    #[serde(default)]
    pub grant_from_prompt: bool,
}

/// One client certificate, and the hosts it is for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientCertificateConfig {
    /// The same rule forms as `allow`.
    pub hosts: Vec<String>,
    /// A PEM certificate chain. `$APPDATA` and the other variables expand.
    pub certificate: String,
    /// The matching PEM private key.
    pub key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyConfig {
    /// `<protocol>://<user>:<password>@<host>:<port>`. Everything but the
    /// host is optional; `http`, `https`, `socks4` and `socks5` are the
    /// protocols.
    pub url: String,
    /// Which hosts go through it. Everything, when this is empty.
    #[serde(default, rename = "for")]
    pub hosts: Vec<String>,
}

/// Where a client certificate lives, with the config's variables expanded.
#[derive(Debug, Clone)]
pub struct CertificatePaths {
    pub certificate: PathBuf,
    pub key: PathBuf,
}

/// The parts of a URL a rule can match on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub scheme: String,
    pub host: String,
    pub port: Option<u16>,
}

impl Endpoint {
    /// Pull the scheme, host and port out of a URL.
    ///
    /// Hand-parsed rather than pulled from a URL crate: only these three
    /// fields matter here, and a parser that ignores everything else cannot
    /// disagree with the HTTP client about the rest.
    pub fn parse(url: &str) -> Result<Self, ApiError> {
        let (scheme, rest) = url
            .split_once("://")
            .ok_or_else(|| ApiError::invalid_params(format!("`{url}` is not an absolute URL")))?;

        if scheme.is_empty()
            || !scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
        {
            return Err(ApiError::invalid_params(format!(
                "`{url}` has no usable scheme"
            )));
        }

        // Everything from the first `/`, `?` or `#` is the path; before it,
        // anything after an `@` is the authority.
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let authority = authority.rsplit('@').next().unwrap_or(authority);

        let (host, port) = split_host_port(authority)?;
        if host.is_empty() {
            return Err(ApiError::invalid_params(format!("`{url}` has no host")));
        }

        Ok(Self {
            scheme: scheme.to_ascii_lowercase(),
            host: host.to_ascii_lowercase(),
            port,
        })
    }

    fn ip(&self) -> Option<IpAddr> {
        self.host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse()
            .ok()
    }
}

fn split_host_port(authority: &str) -> Result<(String, Option<u16>), ApiError> {
    // A bracketed IPv6 literal keeps its colons.
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .ok_or_else(|| ApiError::invalid_params("Unterminated IPv6 address in URL"))?;
        let port = match tail.strip_prefix(':') {
            Some(port) => Some(parse_port(port)?),
            None => None,
        };
        return Ok((host.to_string(), port));
    }

    match authority.rsplit_once(':') {
        Some((host, port)) => Ok((host.to_string(), Some(parse_port(port)?))),
        None => Ok((authority.to_string(), None)),
    }
}

fn parse_port(text: &str) -> Result<u16, ApiError> {
    text.parse()
        .map_err(|_| ApiError::invalid_params(format!("`{text}` is not a port number")))
}

/// One compiled rule.
#[derive(Debug)]
enum Rule {
    AnyHost,
    Host(String),
    /// `*.example.com` - anything strictly beneath it.
    Suffix(String),
    Cidr {
        network: IpAddr,
        prefix: u8,
    },
    Origin {
        scheme: String,
        host: Box<Rule>,
        port: Option<u16>,
    },
}

impl Rule {
    fn compile(rule: &str) -> Result<Self, String> {
        if let Some((scheme, rest)) = rule.split_once("://") {
            let (host, port) = split_host_port(rest.trim_end_matches('/'))
                .map_err(|e| format!("Invalid network rule `{rule}`: {}", e.message))?;
            return Ok(Rule::Origin {
                scheme: http_equivalent(&scheme.to_ascii_lowercase()).to_string(),
                host: Box::new(Rule::compile_host(&host)?),
                port,
            });
        }

        if rule.contains('/') {
            return Self::compile_cidr(rule);
        }

        Self::compile_host(rule)
    }

    fn compile_host(rule: &str) -> Result<Self, String> {
        if rule == "*" {
            return Ok(Rule::AnyHost);
        }
        if let Some(suffix) = rule.strip_prefix("*.") {
            if suffix.is_empty() {
                return Err("`*.` is not a host rule".to_string());
            }
            return Ok(Rule::Suffix(format!(".{}", suffix.to_ascii_lowercase())));
        }
        if rule.contains('*') {
            return Err(format!(
                "Invalid network rule `{rule}`: a wildcard is only allowed as a leading `*.`"
            ));
        }
        Ok(Rule::Host(rule.to_ascii_lowercase()))
    }

    fn compile_cidr(rule: &str) -> Result<Self, String> {
        let (address, prefix) = rule
            .split_once('/')
            .ok_or_else(|| format!("Invalid network rule `{rule}`"))?;

        let network: IpAddr = address.parse().map_err(|_| {
            format!("Invalid network rule `{rule}`: `{address}` is not an IP address")
        })?;
        let prefix: u8 = prefix.parse().map_err(|_| {
            format!("Invalid network rule `{rule}`: `{prefix}` is not a prefix length")
        })?;

        let width = if network.is_ipv4() { 32 } else { 128 };
        if prefix > width {
            return Err(format!(
                "Invalid network rule `{rule}`: /{prefix} is wider than the address"
            ));
        }

        Ok(Rule::Cidr { network, prefix })
    }

    fn matches(&self, endpoint: &Endpoint) -> bool {
        match self {
            Rule::AnyHost => true,
            Rule::Host(host) => &endpoint.host == host,
            Rule::Suffix(suffix) => endpoint.host.ends_with(suffix.as_str()),
            Rule::Cidr { network, prefix } => endpoint
                .ip()
                .is_some_and(|address| in_network(address, *network, *prefix)),
            Rule::Origin { scheme, host, port } => {
                http_equivalent(&endpoint.scheme) == scheme
                    && host.matches(endpoint)
                    && port.is_none_or(|expected| endpoint.port == Some(expected))
            }
        }
    }
}

/// `ws` and `wss` are `http` and `https`.
///
/// A WebSocket handshake is an HTTP GET with an `Upgrade` header, to the same
/// server on the same port. Making `http://host:9123` refuse `ws://host:9123`
/// would be a distinction with no security in it, and a trap whose fix is not
/// obvious from the error - so an origin rule covers both, whichever way it
/// is written.
fn http_equivalent(scheme: &str) -> &str {
    match scheme {
        "ws" => "http",
        "wss" => "https",
        other => other,
    }
}

fn in_network(address: IpAddr, network: IpAddr, prefix: u8) -> bool {
    match (address, network) {
        (IpAddr::V4(address), IpAddr::V4(network)) => {
            masked_v4(address, prefix) == masked_v4(network, prefix)
        }
        (IpAddr::V6(address), IpAddr::V6(network)) => {
            masked_v6(address, prefix) == masked_v6(network, prefix)
        }
        // A v4 address is never inside a v6 range, or the other way round.
        _ => false,
    }
}

fn masked_v4(address: Ipv4Addr, prefix: u8) -> u32 {
    let bits = u32::from(address);
    if prefix == 0 {
        0
    } else {
        bits & (u32::MAX << (32 - prefix))
    }
}

fn masked_v6(address: Ipv6Addr, prefix: u8) -> u128 {
    let bits = u128::from(address);
    if prefix == 0 {
        0
    } else {
        bits & (u128::MAX << (128 - prefix))
    }
}

/// The compiled network permission.
#[derive(Debug, Default)]
pub struct NetworkScope {
    allow: Vec<Rule>,
    deny: Vec<Rule>,
    insecure: Vec<Rule>,
    certificates: Vec<CompiledCertificate>,
    proxy: Option<CompiledProxy>,
    grant_from_prompt: bool,
    /// Hosts the user allowed when asked. In memory only: a grant lasts for
    /// as long as the application is running and no longer, so nothing here
    /// can quietly widen what the next launch may reach.
    granted: Mutex<HashSet<String>>,
    /// Kept for error messages, so a denial can say what was allowed.
    allowed_source: Vec<String>,
}

#[derive(Debug)]
struct CompiledCertificate {
    hosts: Vec<Rule>,
    paths: CertificatePaths,
}

#[derive(Debug)]
struct CompiledProxy {
    url: String,
    /// Empty means every host.
    hosts: Vec<Rule>,
}

impl NetworkScope {
    pub fn compile(config: &NetworkConfig, vars: &Vars) -> Result<Self, String> {
        let mut certificates = Vec::new();
        for entry in &config.client_certificates {
            if entry.hosts.is_empty() {
                return Err(
                    "A `clientCertificates` entry has no `hosts`: say which hosts it is for"
                        .to_string(),
                );
            }
            certificates.push(CompiledCertificate {
                hosts: compile_all(&entry.hosts)?,
                paths: CertificatePaths {
                    certificate: PathBuf::from(vars.expand(&entry.certificate)),
                    key: PathBuf::from(vars.expand(&entry.key)),
                },
            });
        }

        let proxy = match &config.proxy {
            Some(proxy) => Some(CompiledProxy {
                url: proxy.url.clone(),
                hosts: compile_all(&proxy.hosts)?,
            }),
            None => None,
        };

        Ok(Self {
            allow: compile_all(&config.allow)?,
            deny: compile_all(&config.deny)?,
            insecure: compile_all(&config.allow_invalid_certificates)?,
            certificates,
            proxy,
            grant_from_prompt: config.grant_from_prompt,
            granted: Mutex::new(HashSet::new()),
            allowed_source: config.allow.clone(),
        })
    }

    /// Check a URL, returning the endpoint it resolved to.
    pub fn check(&self, url: &str) -> Result<Endpoint, ApiError> {
        let endpoint = Endpoint::parse(url)?;

        if self.deny.iter().any(|rule| rule.matches(&endpoint)) {
            return Err(self.denied(&endpoint, "denied by `permissions.network.deny`"));
        }
        if self.allow.iter().any(|rule| rule.matches(&endpoint)) {
            return Ok(endpoint);
        }
        if self.is_granted(&endpoint.host) {
            return Ok(endpoint);
        }
        Err(self.denied(&endpoint, "not in `permissions.network.allow`"))
    }

    /// Whether this URL is one the user could be asked about.
    ///
    /// `None` when `grantFromPrompt` is off, when the URL is not one, or -
    /// importantly - when `deny` covers it. A denied host is a decision the
    /// developer already made, and no dialog may overturn it.
    pub fn promptable(&self, url: &str) -> Option<Endpoint> {
        if !self.grant_from_prompt {
            return None;
        }
        let endpoint = Endpoint::parse(url).ok()?;
        if self.deny.iter().any(|rule| rule.matches(&endpoint)) {
            return None;
        }
        Some(endpoint)
    }

    /// Remember that the user said yes to this host, for this run.
    pub fn grant(&self, host: &str) {
        self.granted
            .lock()
            .expect("network grants poisoned")
            .insert(host.to_ascii_lowercase());
    }

    fn is_granted(&self, host: &str) -> bool {
        self.granted
            .lock()
            .expect("network grants poisoned")
            .contains(host)
    }

    /// Whether this host may be reached without a trusted certificate.
    pub fn allows_invalid_certificate(&self, endpoint: &Endpoint) -> bool {
        self.insecure.iter().any(|rule| rule.matches(endpoint))
    }

    /// The client certificate to present to this host, if the config named
    /// one. The first matching entry wins, so order is the tie-breaker.
    pub fn client_certificate(&self, endpoint: &Endpoint) -> Option<&CertificatePaths> {
        self.certificates
            .iter()
            .find(|entry| entry.hosts.iter().any(|rule| rule.matches(endpoint)))
            .map(|entry| &entry.paths)
    }

    /// The proxy this host should be reached through, if any.
    pub fn proxy(&self, endpoint: &Endpoint) -> Option<&str> {
        let proxy = self.proxy.as_ref()?;
        // No `for` list is "everything", which is what a debugging proxy or a
        // corporate egress usually means.
        if proxy.hosts.is_empty() || proxy.hosts.iter().any(|rule| rule.matches(endpoint)) {
            Some(&proxy.url)
        } else {
            None
        }
    }

    fn denied(&self, endpoint: &Endpoint, reason: &str) -> ApiError {
        ApiError::denied(format!(
            "`{}://{}` is {reason}. Allowed: {}",
            endpoint.scheme,
            endpoint.host,
            if self.allowed_source.is_empty() {
                "nothing".to_string()
            } else {
                self.allowed_source.join(", ")
            }
        ))
        .with_data(serde_json::json!({ "host": endpoint.host, "scheme": endpoint.scheme }))
    }
}

fn compile_all(rules: &[String]) -> Result<Vec<Rule>, String> {
    rules.iter().map(|rule| Rule::compile(rule)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn scope_for(allow: &[&str]) -> NetworkScope {
        scope(allow)
    }

    fn scope(allow: &[&str]) -> NetworkScope {
        compile(NetworkConfig {
            allow: allow.iter().map(|rule| rule.to_string()).collect(),
            ..NetworkConfig::default()
        })
    }

    fn compile(config: NetworkConfig) -> NetworkScope {
        NetworkScope::compile(&config, &test_vars()).expect("rules compile")
    }

    fn test_vars() -> Vars {
        Vars::resolve("dev.vantail.test", std::path::Path::new("/tmp"))
    }

    #[test]
    fn urls_split_into_scheme_host_and_port() {
        let endpoint = Endpoint::parse("https://api.example.com/v1/users?id=1").unwrap();
        assert_eq!(endpoint.scheme, "https");
        assert_eq!(endpoint.host, "api.example.com");
        assert_eq!(endpoint.port, None);

        let with_port = Endpoint::parse("http://192.168.1.50:9123/api/lights").unwrap();
        assert_eq!(with_port.port, Some(9123));

        let ipv6 = Endpoint::parse("http://[fd00::1]:8080/x").unwrap();
        assert_eq!(ipv6.host, "fd00::1");
        assert_eq!(ipv6.port, Some(8080));

        // Credentials in the authority are not the host.
        let userinfo = Endpoint::parse("http://user:pass@device.local/api").unwrap();
        assert_eq!(userinfo.host, "device.local");
    }

    #[test]
    fn a_relative_url_is_rejected_rather_than_guessed_at() {
        assert!(Endpoint::parse("/v1/users").is_err());
        assert!(Endpoint::parse("api.example.com").is_err());
    }

    #[test]
    fn nothing_is_reachable_by_default() {
        assert!(scope(&[]).check("https://api.example.com/x").is_err());
    }

    #[test]
    fn an_exact_host_matches_any_scheme_and_port() {
        let scope = scope(&["api.example.com"]);
        assert!(scope.check("https://api.example.com/v1").is_ok());
        assert!(scope.check("http://api.example.com:8080/v1").is_ok());
        assert!(scope.check("https://api.example.com.evil.com/").is_err());
        assert!(scope.check("https://example.com/").is_err());
    }

    #[test]
    fn a_wildcard_covers_subdomains_but_not_the_apex() {
        let scope = scope(&["*.example.com"]);
        assert!(scope.check("https://api.example.com/").is_ok());
        assert!(scope.check("https://events.example.com/").is_ok());
        // Listing the apex is a separate decision, so it has to be written.
        assert!(scope.check("https://example.com/").is_err());
        // And the suffix has to be a real boundary.
        assert!(scope.check("https://notexample.com/").is_err());
    }

    #[test]
    fn a_bare_wildcard_allows_every_host() {
        // The honest declaration for an application whose whole job is to
        // reach a host the user names at run time. Untested until now, which
        // is how `docs/permissions.md` came to leave it out.
        let scope = scope(&["*"]);
        assert!(scope.check("https://example.museum/").is_ok());
        assert!(scope.check("http://192.168.1.50:9123/x").is_ok());
        assert!(scope.check("https://api.example.com/v1").is_ok());
    }

    #[test]
    fn a_bare_wildcard_still_loses_to_deny() {
        // `*` is a way to say "anywhere", not a way to switch the fence off.
        let scope = compile(NetworkConfig {
            allow: vec!["*".into()],
            deny: vec!["metadata.google.internal".into(), "169.254.0.0/16".into()],
            ..NetworkConfig::default()
        });

        assert!(scope.check("https://example.museum/").is_ok());
        assert!(scope.check("http://metadata.google.internal/").is_err());
        assert!(scope
            .check("http://169.254.169.254/latest/meta-data")
            .is_err());
    }

    #[test]
    fn a_wildcard_origin_pins_the_scheme_but_not_the_host() {
        // `https://*` is the "anywhere, but not in the clear" rule.
        let scope = scope(&["https://*"]);
        assert!(scope.check("https://example.museum/").is_ok());
        assert!(scope.check("http://example.museum/").is_err());
    }

    #[test]
    fn allowing_everything_does_not_also_stop_checking_certificates() {
        // The two decisions stay separate: `*` is "may talk to anywhere", not
        // "may talk to anywhere without knowing who is answering".
        let scope = scope(&["*"]);
        let endpoint = scope.check("https://example.museum/").unwrap();
        assert!(!scope.allows_invalid_certificate(&endpoint));
    }

    #[test]
    fn a_wildcard_anywhere_else_is_a_configuration_error() {
        assert!(NetworkScope::compile(
            &NetworkConfig {
                allow: vec!["api.*.tv".into()],
                ..NetworkConfig::default()
            },
            &test_vars()
        )
        .is_err());
    }

    #[test]
    fn cidr_rules_cover_a_range_of_addresses() {
        let scope = scope(&["192.168.0.0/16"]);
        assert!(scope.check("http://192.168.1.50:9123/x").is_ok());
        assert!(scope.check("http://192.168.255.255/x").is_ok());
        assert!(scope.check("http://10.0.0.1/x").is_err());
        // A hostname is not an address, even one that resolves into the range.
        assert!(scope.check("http://hub.local/x").is_err());
    }

    #[test]
    fn cidr_rules_do_not_leak_between_address_families() {
        let scope = scope(&["::/0"]);
        assert!(scope.check("http://[fd00::1]/x").is_ok());
        assert!(scope.check("http://192.168.1.1/x").is_err());
    }

    #[test]
    fn an_origin_rule_pins_the_scheme_and_optionally_the_port() {
        let scope = scope(&["http://192.168.1.50:9123"]);
        assert!(scope.check("http://192.168.1.50:9123/api/lights").is_ok());
        assert!(scope.check("https://192.168.1.50:9123/x").is_err());
        assert!(scope.check("http://192.168.1.50:80/x").is_err());

        let any_port = scope_for(&["http://192.168.1.50"]);
        assert!(any_port.check("http://192.168.1.50:9123/x").is_ok());
        assert!(any_port.check("http://192.168.1.50/x").is_ok());
    }

    #[test]
    fn deny_beats_allow() {
        let scope = compile(NetworkConfig {
            allow: vec!["*.example.com".into()],
            deny: vec!["evil.example.com".into()],
            ..NetworkConfig::default()
        });

        assert!(scope.check("https://api.example.com/").is_ok());
        assert!(scope.check("https://evil.example.com/").is_err());
    }

    #[test]
    fn skipping_certificate_checks_is_its_own_permission() {
        let scope = compile(NetworkConfig {
            allow: vec!["192.168.0.0/16".into(), "api.example.com".into()],
            allow_invalid_certificates: vec!["192.168.0.0/16".into()],
            ..NetworkConfig::default()
        });

        let bridge = scope.check("https://192.168.1.7/clip/v2").unwrap();
        assert!(scope.allows_invalid_certificate(&bridge));

        // Being allowed to reach the service is not permission to stop checking
        // who is answering as the service.
        let allowed = scope.check("https://api.example.com/v1").unwrap();
        assert!(!scope.allows_invalid_certificate(&allowed));
    }

    #[test]
    fn a_client_certificate_is_presented_only_to_the_hosts_it_is_for() {
        let scope = compile(NetworkConfig {
            allow: vec!["*".into()],
            client_certificates: vec![ClientCertificateConfig {
                hosts: vec!["*.bank.example".into()],
                certificate: "$APPDATA/client.pem".into(),
                key: "$APPDATA/client.key".into(),
            }],
            ..NetworkConfig::default()
        });

        let bank = scope.check("https://api.bank.example/v1").unwrap();
        let paths = scope.client_certificate(&bank).expect("a certificate");
        // The config's variables are expanded once, at compile time.
        assert!(!paths.certificate.to_string_lossy().contains("$APPDATA"));
        assert!(paths.certificate.ends_with("client.pem"));
        assert!(paths.key.ends_with("client.key"));

        // Everywhere else gets no certificate at all: a client key is an
        // identity, and handing it to the wrong host is how it leaks.
        let elsewhere = scope.check("https://api.example.com/v1").unwrap();
        assert!(scope.client_certificate(&elsewhere).is_none());
    }

    #[test]
    fn the_first_matching_certificate_wins() {
        let scope = compile(NetworkConfig {
            allow: vec!["*".into()],
            client_certificates: vec![
                ClientCertificateConfig {
                    hosts: vec!["api.bank.example".into()],
                    certificate: "/one.pem".into(),
                    key: "/one.key".into(),
                },
                ClientCertificateConfig {
                    hosts: vec!["*.bank.example".into()],
                    certificate: "/two.pem".into(),
                    key: "/two.key".into(),
                },
            ],
            ..NetworkConfig::default()
        });

        let exact = scope.check("https://api.bank.example/").unwrap();
        assert!(scope
            .client_certificate(&exact)
            .unwrap()
            .certificate
            .ends_with("one.pem"));

        let under = scope.check("https://files.bank.example/").unwrap();
        assert!(scope
            .client_certificate(&under)
            .unwrap()
            .certificate
            .ends_with("two.pem"));
    }

    #[test]
    fn a_certificate_entry_has_to_say_which_hosts_it_is_for() {
        // Otherwise the sensible-looking reading is "all of them", which is
        // exactly the mistake that leaks a client key.
        assert!(NetworkScope::compile(
            &NetworkConfig {
                client_certificates: vec![ClientCertificateConfig {
                    hosts: vec![],
                    certificate: "/c.pem".into(),
                    key: "/c.key".into(),
                }],
                ..NetworkConfig::default()
            },
            &test_vars()
        )
        .is_err());
    }

    #[test]
    fn a_proxy_without_a_host_list_covers_everything() {
        let scope = compile(NetworkConfig {
            allow: vec!["*".into()],
            proxy: Some(ProxyConfig {
                url: "http://127.0.0.1:8888".into(),
                hosts: vec![],
            }),
            ..NetworkConfig::default()
        });

        let anywhere = scope.check("https://example.museum/").unwrap();
        assert_eq!(scope.proxy(&anywhere), Some("http://127.0.0.1:8888"));
    }

    #[test]
    fn a_proxy_with_a_host_list_covers_only_those() {
        let scope = compile(NetworkConfig {
            allow: vec!["*".into()],
            proxy: Some(ProxyConfig {
                url: "http://127.0.0.1:8888".into(),
                hosts: vec!["*.example.com".into()],
            }),
            ..NetworkConfig::default()
        });

        let through = scope.check("https://api.example.com/").unwrap();
        assert_eq!(scope.proxy(&through), Some("http://127.0.0.1:8888"));

        // A device on the LAN should not be reached through a proxy meant for
        // the internet, which is the whole reason `for` exists.
        let direct = scope.check("http://192.168.1.50:9123/").unwrap();
        assert_eq!(scope.proxy(&direct), None);
    }

    #[test]
    fn no_proxy_is_configured_by_default() {
        let scope = scope(&["*"]);
        let endpoint = scope.check("https://example.com/").unwrap();
        assert_eq!(scope.proxy(&endpoint), None);
        assert!(scope.client_certificate(&endpoint).is_none());
    }

    #[test]
    fn an_origin_rule_covers_the_websocket_on_the_same_port() {
        // The handshake is an HTTP GET on that port, to that server. Writing
        // both would be ceremony, and forgetting to is a trap.
        let scope = scope(&["http://192.168.1.50:9123"]);
        assert!(scope.check("ws://192.168.1.50:9123/socket").is_ok());
        // And the scheme is still pinned: no plaintext promotion to TLS or
        // the other way round.
        assert!(scope.check("wss://192.168.1.50:9123/socket").is_err());

        let secure = scope_for(&["https://api.example.com"]);
        assert!(secure.check("wss://api.example.com/live").is_ok());
        assert!(secure.check("ws://api.example.com/live").is_err());
    }

    #[test]
    fn a_websocket_origin_rule_reads_the_same_the_other_way_round() {
        // Written as `wss://`, it still means that origin - so the ordinary
        // HTTPS calls to the same API are covered by the one rule.
        let scope = scope(&["wss://api.example.com"]);
        assert!(scope.check("wss://api.example.com/live").is_ok());
        assert!(scope.check("https://api.example.com/v1").is_ok());
        assert!(scope.check("http://api.example.com/v1").is_err());
    }

    #[test]
    fn a_bare_host_covers_a_websocket_the_way_it_covers_everything() {
        let scope = scope(&["api.example.com"]);
        assert!(scope.check("wss://api.example.com/live").is_ok());
        assert!(scope.check("ws://api.example.com/live").is_ok());
    }

    #[test]
    fn nothing_is_promptable_unless_the_config_asked_for_it() {
        // Off by default: a static list is the right answer for most
        // applications, and a dialog nobody asked for is not an improvement.
        let scope = scope(&["api.example.com"]);
        assert!(scope.promptable("https://example.museum/").is_none());
    }

    #[test]
    fn a_host_the_user_allowed_is_reachable_afterwards() {
        let scope = compile(NetworkConfig {
            allow: vec!["api.example.com".into()],
            grant_from_prompt: true,
            ..NetworkConfig::default()
        });

        // Refused until somebody says otherwise...
        assert!(scope.check("https://example.museum/v1").is_err());
        let endpoint = scope
            .promptable("https://example.museum/v1")
            .expect("worth asking about");

        // ...and reachable once they have.
        scope.grant(&endpoint.host);
        assert!(scope.check("https://example.museum/v1").is_ok());
        // Any scheme and port, the same as writing the host in `allow`.
        assert!(scope.check("http://example.museum:8080/other").is_ok());

        // And only that host: a grant is not a wildcard.
        assert!(scope.check("https://other.museum/").is_err());
    }

    #[test]
    fn a_denied_host_is_never_worth_asking_about() {
        // The developer already decided. No dialog may overturn it, or `deny`
        // would be a suggestion rather than a rule.
        let scope = compile(NetworkConfig {
            allow: vec!["api.example.com".into()],
            deny: vec!["169.254.0.0/16".into(), "metadata.google.internal".into()],
            grant_from_prompt: true,
            ..NetworkConfig::default()
        });

        assert!(scope.promptable("http://169.254.169.254/latest").is_none());
        assert!(scope
            .promptable("http://metadata.google.internal/")
            .is_none());
        // Something not denied is still worth asking about.
        assert!(scope.promptable("https://example.museum/").is_some());
    }

    #[test]
    fn granting_does_not_also_stop_checking_certificates() {
        let scope = compile(NetworkConfig {
            grant_from_prompt: true,
            ..NetworkConfig::default()
        });
        scope.grant("example.museum");

        let endpoint = scope.check("https://example.museum/").unwrap();
        // "May talk to" is still not "may talk to without knowing who is
        // answering", however the permission was arrived at.
        assert!(!scope.allows_invalid_certificate(&endpoint));
    }

    #[test]
    fn a_grant_is_matched_without_regard_to_case() {
        let scope = compile(NetworkConfig {
            grant_from_prompt: true,
            ..NetworkConfig::default()
        });
        scope.grant("Example.Museum");
        assert!(scope.check("https://example.museum/").is_ok());
    }

    #[test]
    fn a_denial_says_what_was_allowed() {
        let error = scope(&["api.example.com"])
            .check("http://192.168.1.1/")
            .unwrap_err();
        assert_eq!(error.code, crate::error::code::PERMISSION_DENIED);
        assert!(error.message.contains("api.example.com"));
    }
}
