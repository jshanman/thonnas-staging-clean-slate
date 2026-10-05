interface QueryBypassRule {
  /** Query parameter name, e.g. agree-to-terms */
  param: string;
  /** Accepted values (matched case-insensitively), e.g. ["true", "yes"] */
  values: string[];
  /** When true (default), set the gate cookie on bypass */
  setCookie?: boolean;
}

/**
 * Component-owned frontend cookie gate (infra.website.static extras.accessControl).
 * All product-specific values (cookie name/value, challenge page, bypass params) come from thonnas-infra.json.
 */
interface FrontendCookieGateConfig {
  type: 'frontend-cookie-gate';
  cookieName: string;
  cookieValue: string;
  cookieTtlDays?: number;
  cookiePath?: string;
  cookieSecure?: boolean;
  cookieSameSite?: string;
  /** Path to the unauthenticated challenge/gate page (required). Alias: termsPath. */
  challengePath?: string;
  /** @deprecated Prefer challengePath */
  termsPath?: string;
  returnParam?: string;
  publicPaths?: string[];
  /** Optional query-param bypass rules owned by the component infra extras */
  queryBypass?: QueryBypassRule | QueryBypassRule[];
}

function isFrontendCookieGateConfig(value: unknown): value is FrontendCookieGateConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Record<string, unknown>;
  const challengePath =
    (typeof config.challengePath === 'string' && config.challengePath.trim()) ||
    (typeof config.termsPath === 'string' && config.termsPath.trim()) ||
    '';
  return (
    config.type === 'frontend-cookie-gate' &&
    typeof config.cookieName === 'string' &&
    config.cookieName.trim().length > 0 &&
    typeof config.cookieValue === 'string' &&
    config.cookieValue.trim().length > 0 &&
    challengePath.length > 0
  );
}

function normalizeUriPath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  if (!raw) return '';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function resolveCookieTtlDays(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return 30;
}

function resolveCookiePath(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    return normalizeUriPath(value, '/');
  }
  return '/';
}

function resolveCookieSameSite(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return 'Lax';
}

// @intent Normalize optional queryBypass extras into a stable list for CF function config
function normalizeQueryBypassRules(value: unknown): Array<{
  param: string;
  values: string[];
  setCookie: boolean;
}> {
  if (!value) return [];
  const rawList = Array.isArray(value) ? value : [value];
  const rules: Array<{ param: string; values: string[]; setCookie: boolean }> = [];

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const param = typeof record.param === 'string' ? record.param.trim() : '';
    if (!param) continue;

    const valuesRaw = Array.isArray(record.values)
      ? record.values
      : typeof record.value === 'string'
        ? [record.value]
        : [];
    const values = valuesRaw
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim().toLowerCase());
    if (values.length === 0) continue;

    rules.push({
      param,
      values,
      setCookie: record.setCookie !== false,
    });
  }

  return rules;
}

// @intent Rewrite /path and /path/ to /path/index.html for S3 (Docusaurus omits trailing slashes)
function buildDirectoryIndexRewriteBody(uriExpr: string, requestUriAssign: string): string {
  return `
  var __u = ${uriExpr};
  if (__u.endsWith('/')) {
    ${requestUriAssign} = __u + 'index.html';
  } else {
    var __i = __u.lastIndexOf('/');
    var __seg = __i >= 0 ? __u.substring(__i + 1) : __u;
    var __ext = __seg.match(/\\.([^.]+)$/);
    // Numeric-only "ext" (e.g. 0.3.0) is a version path, not a static file
    var __isFile = Boolean(__ext && !/^\\d+$/.test(__ext[1]));
    if (__seg && !__isFile) {
      ${requestUriAssign} = __u + '/index.html';
    }
  }`.trim();
}

export function buildViewerRequestFunctionCode(accessControl: unknown): string {
  const denyReleaseMeta =
    'if (r.uri === "/.thonnas-release" || r.uri.indexOf("/.thonnas-release/") === 0) { return { statusCode: 403, statusDescription: "Forbidden", body: "Forbidden" }; }';
  const baseDirIndex = `function handler(event) { var r = event.request; ${denyReleaseMeta} ${buildDirectoryIndexRewriteBody(
    'r.uri',
    'r.uri',
  )} return r; }`;

  if (!isFrontendCookieGateConfig(accessControl)) return baseDirIndex;

  // @intent Challenge path is component-owned; no provider default like /terms
  const challengePath = normalizeUriPath(
    accessControl.challengePath ?? accessControl.termsPath,
    '',
  );
  if (!challengePath) return baseDirIndex;

  const challengeIndexPath = challengePath.endsWith('/')
    ? `${challengePath}index.html`
    : `${challengePath}/index.html`;
  const returnParam = accessControl.returnParam?.trim() || 'return';
  const cookieTtlDays = resolveCookieTtlDays(accessControl.cookieTtlDays);
  const cookiePath = resolveCookiePath(accessControl.cookiePath);
  const cookieSecure = accessControl.cookieSecure !== false;
  const cookieSameSite = resolveCookieSameSite(accessControl.cookieSameSite);
  const queryBypasses = normalizeQueryBypassRules(accessControl.queryBypass);
  const publicPaths = Array.from(
    new Set([challengePath, `${challengePath}/*`, ...(accessControl.publicPaths ?? [])]),
  )
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => normalizeUriPath(item, item));

  const configJson = JSON.stringify({
    cookieName: accessControl.cookieName,
    cookieValue: accessControl.cookieValue,
    cookieTtlDays,
    cookiePath,
    cookieSecure,
    cookieSameSite,
    challengePath,
    challengeIndexPath,
    returnParam,
    publicPaths,
    queryBypasses,
  });

  return `
var config = ${configJson};

function isPublicPath(uri) {
  for (var i = 0; i < config.publicPaths.length; i++) {
    var pattern = config.publicPaths[i];
    if (pattern.slice(-2) === '/*') {
      var prefix = pattern.slice(0, -1);
      if (uri.indexOf(prefix) === 0) return true;
    } else if (uri === pattern) {
      return true;
    }
  }
  return false;
}

function getQueryParam(querystring, name) {
  if (!querystring || !querystring[name]) return '';
  var item = querystring[name];
  if (item.multiValue && item.multiValue.length) {
    return item.multiValue[0].value || '';
  }
  return item.value || '';
}

function queryStringToString(querystring, skipKey) {
  var pairs = [];
  for (var key in querystring) {
    if (!Object.prototype.hasOwnProperty.call(querystring, key)) continue;
    if (skipKey && key === skipKey) continue;
    var item = querystring[key];
    if (item.multiValue) {
      for (var i = 0; i < item.multiValue.length; i++) {
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(item.multiValue[i].value || ''));
      }
    } else {
      pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(item.value || ''));
    }
  }
  return pairs.join('&');
}

function findQueryBypass(querystring) {
  if (!config.queryBypasses || !config.queryBypasses.length) return null;
  for (var i = 0; i < config.queryBypasses.length; i++) {
    var rule = config.queryBypasses[i];
    var value = (getQueryParam(querystring, rule.param) || '').toLowerCase();
    if (!value) continue;
    for (var j = 0; j < rule.values.length; j++) {
      if (value === rule.values[j]) return rule;
    }
  }
  return null;
}

function hasAcceptedCookie(request) {
  var cookie = request.cookies && request.cookies[config.cookieName];
  return Boolean(cookie && cookie.value === config.cookieValue);
}

function gateCookieHeader() {
  var maxAge = config.cookieTtlDays * 24 * 60 * 60;
  var parts = [
    config.cookieName + '=' + config.cookieValue,
    'Path=' + config.cookiePath,
    'SameSite=' + config.cookieSameSite,
    'Max-Age=' + maxAge
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function applyStaticSiteRewrite(request) {
  if (request.uri === config.challengePath) {
    request.uri = config.challengeIndexPath;
    return request;
  }
  ${buildDirectoryIndexRewriteBody('request.uri', 'request.uri')}
  return request;
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/.thonnas-release' || uri.indexOf('/.thonnas-release/') === 0) {
    return { statusCode: 403, statusDescription: 'Forbidden', body: 'Forbidden' };
  }

  if (isPublicPath(uri)) {
    return applyStaticSiteRewrite(request);
  }

  // @intent Apply component-declared query bypass rules and optionally set gate cookie
  var bypass = findQueryBypass(request.querystring);
  if (bypass) {
    var cleanedQs = queryStringToString(request.querystring || {}, bypass.param);
    var headers = {
      location: { value: uri + (cleanedQs ? '?' + cleanedQs : '') },
      'cache-control': { value: 'no-store' }
    };
    if (bypass.setCookie) {
      headers['set-cookie'] = { value: gateCookieHeader() };
    }
    return {
      statusCode: 302,
      statusDescription: 'Found',
      headers: headers
    };
  }

  if (hasAcceptedCookie(request)) {
    return applyStaticSiteRewrite(request);
  }

  var qs = queryStringToString(request.querystring || {});
  var original = uri + (qs ? '?' + qs : '');
  return {
    statusCode: 302,
    statusDescription: 'Found',
    headers: {
      location: { value: config.challengePath + '?' + encodeURIComponent(config.returnParam) + '=' + encodeURIComponent(original) },
      'cache-control': { value: 'no-store' }
    }
  };
}
`.trim();
}



