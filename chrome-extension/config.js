/**
 * Address of the Scopos demo server (the Cloudflare Worker in proxy/), ending in /v1/messages.
 * People without their own Anthropic key go through it. Left empty, everyone needs a key.
 * The server's origin must also be listed in host_permissions in manifest.json.
 */
self.SCOPOS_CONFIG = {
  demoProxyUrl: 'https://scopos-proxy.boburbek.workers.dev/v1/messages',
};
