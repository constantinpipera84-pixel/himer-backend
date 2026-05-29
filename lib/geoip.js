/**
 * HIMER — IP Geolocation Helper
 *
 * Free services (no API key needed):
 *   - ip-api.com: 45 req/min, includes lat/lng/city/country
 *   - ipinfo.io fallback
 *
 * Cached aggressively (24h per IP) to stay within free limits.
 */
const https = require('https');
const http = require('http');

const cache = new Map(); // ip -> { data, expires }
const CACHE_TTL = 24 * 3600 * 1000; // 24h

function fetchJSON(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function geolocate(ip) {
  // Normalize IPv6-mapped IPv4
  if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7);
  // Skip private/loopback IPs
  if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip === '::1') {
    return { country: 'Local', lat: 44.4268, lng: 26.1025, city: 'Bucharest', region: 'EU' };
  }
  // Cache check
  const cached = cache.get(ip);
  if (cached && cached.expires > Date.now()) return cached.data;

  // Try ip-api.com (free, no key)
  const data = await fetchJSON(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,region,regionName,city,lat,lon,timezone,isp`);
  let geo = null;
  if (data && data.status === 'success') {
    geo = {
      country: data.country || 'Unknown',
      countryCode: data.countryCode || '',
      regionName: data.regionName || '',
      city: data.city || '',
      lat: data.lat || 0,
      lng: data.lon || 0,
      timezone: data.timezone || '',
      isp: data.isp || '',
      region: deriveRegion(data.countryCode),
    };
  } else {
    // Fallback to country-only via Cloudflare CF-IPCountry header (set elsewhere)
    geo = { country: 'Unknown', lat: 0, lng: 0, region: 'EU' };
  }

  cache.set(ip, { data: geo, expires: Date.now() + CACHE_TTL });
  return geo;
}

function deriveRegion(cc) {
  if (!cc) return 'EU';
  const NA = ['US','CA','MX'];
  const EU = ['RO','DE','FR','GB','IT','ES','PT','NL','BE','PL','CZ','HU','AT','CH','SE','NO','FI','DK','IE','GR','BG','HR','SK','SI','EE','LV','LT','LU','MT','CY'];
  const ASIA = ['CN','JP','KR','IN','SG','HK','TW','TH','VN','ID','PH','MY','PK','BD'];
  const SA = ['BR','AR','CL','CO','PE','VE','UY'];
  const AF = ['ZA','NG','EG','KE','MA','GH','ET','TZ','DZ'];
  const OC = ['AU','NZ'];
  if (NA.includes(cc)) return 'NA';
  if (EU.includes(cc)) return 'EU';
  if (ASIA.includes(cc)) return 'ASIA';
  if (SA.includes(cc)) return 'SA';
  if (AF.includes(cc)) return 'AF';
  if (OC.includes(cc)) return 'OC';
  return 'OTHER';
}

// Cloudflare CF-IPCountry header (set by Cloudflare proxy if used)
function geoFromHeaders(headers) {
  const cc = headers['cf-ipcountry'] || headers['CF-IPCountry'];
  if (!cc || cc === 'XX' || cc === 'T1') return null;
  return { countryCode: cc, region: deriveRegion(cc) };
}

module.exports = { geolocate, geoFromHeaders, deriveRegion };
