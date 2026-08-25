//! Just enough semver to answer "is that one newer than this one?".
//!
//! A dependency would be more thorough, but the question the updater asks is
//! narrow and getting `1.10.0 > 1.9.0` right is most of it.

use std::cmp::Ordering;

/// Compare two version strings.
///
/// Missing components count as zero, so `1.2` and `1.2.0` are equal. Build
/// metadata after `+` is ignored, as the spec requires. A pre-release sorts
/// below the release it leads to: `1.2.0-beta.1 < 1.2.0`.
pub fn compare(left: &str, right: &str) -> Ordering {
    let (left_core, left_pre) = split(left);
    let (right_core, right_pre) = split(right);

    let core = compare_core(left_core, right_core);
    if core != Ordering::Equal {
        return core;
    }

    match (left_pre, right_pre) {
        (None, None) => Ordering::Equal,
        // A release outranks any pre-release of the same core version.
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => compare_prerelease(left, right),
    }
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    compare(candidate, current) == Ordering::Greater
}

fn split(version: &str) -> (&str, Option<&str>) {
    let version = version.trim().trim_start_matches('v');
    // Build metadata never affects precedence.
    let version = version.split('+').next().unwrap_or(version);

    match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    }
}

fn compare_core(left: &str, right: &str) -> Ordering {
    let mut left = left.split('.');
    let mut right = right.split('.');

    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (a, b) => {
                let a = a.and_then(|part| part.parse::<u64>().ok()).unwrap_or(0);
                let b = b.and_then(|part| part.parse::<u64>().ok()).unwrap_or(0);
                match a.cmp(&b) {
                    Ordering::Equal => continue,
                    other => return other,
                }
            }
        }
    }
}

fn compare_prerelease(left: &str, right: &str) -> Ordering {
    let mut left = left.split('.');
    let mut right = right.split('.');

    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            // Fewer identifiers sorts lower: `1.0.0-alpha < 1.0.0-alpha.1`.
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b)) => {
                let order = match (a.parse::<u64>(), b.parse::<u64>()) {
                    (Ok(a), Ok(b)) => a.cmp(&b),
                    // Numeric identifiers always sort below alphanumeric ones.
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => a.cmp(b),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_numerically_not_lexically() {
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.9.0", "1.10.0"));
    }

    #[test]
    fn equal_versions_are_not_newer() {
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert_eq!(compare("1.2", "1.2.0"), Ordering::Equal);
    }

    #[test]
    fn a_leading_v_and_build_metadata_are_ignored() {
        assert_eq!(compare("v1.2.3", "1.2.3"), Ordering::Equal);
        assert_eq!(compare("1.2.3+build.9", "1.2.3"), Ordering::Equal);
    }

    #[test]
    fn a_release_outranks_its_own_prereleases() {
        assert!(is_newer("1.2.0", "1.2.0-beta.1"));
        assert!(!is_newer("1.2.0-beta.1", "1.2.0"));
    }

    #[test]
    fn prereleases_order_among_themselves() {
        assert!(is_newer("1.0.0-beta", "1.0.0-alpha"));
        assert!(is_newer("1.0.0-alpha.2", "1.0.0-alpha.1"));
        assert!(is_newer("1.0.0-alpha.1", "1.0.0-alpha"));
        // Numeric identifiers sort below alphanumeric ones.
        assert!(is_newer("1.0.0-alpha.beta", "1.0.0-alpha.1"));
    }

    #[test]
    fn nonsense_does_not_look_newer() {
        assert!(!is_newer("not-a-version", "1.0.0"));
        assert!(!is_newer("", "0.0.1"));
    }
}
