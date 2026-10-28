import { BlockList, isIP } from 'node:net';

function address(value) {
  if (typeof value !== 'string') return null;
  const plain = value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  return isIP(plain) ? plain : null;
}

// Forwarded addresses are evidence only when received through explicitly trusted peers.
export function clientAddressResolver(cidrs = process.env.TRUSTED_PROXY_CIDRS || '') {
  const trusted = new BlockList();
  for (const entry of cidrs.split(',').map(value => value.trim()).filter(Boolean)) {
    const [raw, bits, extra] = entry.split('/'), ip = address(raw), version = isIP(ip || '');
    if (!ip || extra !== undefined || (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) < 1 || Number(bits) > (version === 4 ? 32 : 128)))) throw new Error('TRUSTED_PROXY_CIDRS must contain explicit IP addresses or non-global CIDR networks.');
    const family = version === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) trusted.addAddress(ip, family);
    else trusted.addSubnet(ip, Number(bits), family);
  }
  const isTrusted = ip => trusted.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
  return request => {
    const peer = address(request.socket?.remoteAddress);
    if (!peer) return 'local';
    const header = request.headers['x-forwarded-for'];
    if (!isTrusted(peer) || typeof header !== 'string' || header.length > 2048) return peer;
    const chain = header.split(',').map(value => address(value.trim()));
    if (!chain.length || chain.length > 20 || chain.some(ip => !ip)) return peer;
    for (let index = chain.length - 1; index >= 0; index--) if (!isTrusted(chain[index])) return chain[index];
    return chain[0];
  };
}
