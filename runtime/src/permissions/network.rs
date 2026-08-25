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

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::Deserialize;

use crate::error::ApiError;

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
                scheme: scheme.to_ascii_lowercase(),
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
                &endpoint.scheme == scheme
                    && host.matches(endpoint)
                    && port.is_none_or(|expected| endpoint.port == Some(expected))
            }
        }
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
    /// Kept for error messages, so a denial can say what was allowed.
    allowed_source: Vec<String>,
}

impl NetworkScope {
    pub fn compile(config: &NetworkConfig) -> Result<Self, String> {
        Ok(Self {
            allow: compile_all(&config.allow)?,
            deny: compile_all(&config.deny)?,
            insecure: compile_all(&config.allow_invalid_certificates)?,
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
        Err(self.denied(&endpoint, "not in `permissions.network.allow`"))
    }

    /// Whether this host may be reached without a trusted certificate.
    pub fn allows_invalid_certificate(&self, endpoint: &Endpoint) -> bool {
        self.insecure.iter().any(|rule| rule.matches(endpoint))
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
        NetworkScope::compile(&NetworkConfig {
            allow: allow.iter().map(|rule| rule.to_string()).collect(),
            ..NetworkConfig::default()
        })
        .expect("rules compile")
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
    fn a_wildcard_anywhere_else_is_a_configuration_error() {
        assert!(NetworkScope::compile(&NetworkConfig {
            allow: vec!["api.*.tv".into()],
            ..NetworkConfig::default()
        })
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
        let scope = NetworkScope::compile(&NetworkConfig {
            allow: vec!["*.example.com".into()],
            deny: vec!["evil.example.com".into()],
            ..NetworkConfig::default()
        })
        .unwrap();

        assert!(scope.check("https://api.example.com/").is_ok());
        assert!(scope.check("https://evil.example.com/").is_err());
    }

    #[test]
    fn skipping_certificate_checks_is_its_own_permission() {
        let scope = NetworkScope::compile(&NetworkConfig {
            allow: vec!["192.168.0.0/16".into(), "api.example.com".into()],
            allow_invalid_certificates: vec!["192.168.0.0/16".into()],
            ..NetworkConfig::default()
        })
        .unwrap();

        let bridge = scope.check("https://192.168.1.7/clip/v2").unwrap();
        assert!(scope.allows_invalid_certificate(&bridge));

        // Being allowed to reach the service is not permission to stop checking
        // who is answering as the service.
        let allowed = scope.check("https://api.example.com/v1").unwrap();
        assert!(!scope.allows_invalid_certificate(&allowed));
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
