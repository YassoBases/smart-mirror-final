"""Packet destination inventory. Volume is not evidence of biometric absence."""
import argparse
from collections import defaultdict
import importlib
import ipaddress
from pathlib import Path
import shutil

THRESHOLD = 1_000_000
RFC1918 = tuple(ipaddress.ip_network(n) for n in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'))


def destination_kind(value):
    ip = ipaddress.ip_address(value)
    if ip.is_loopback:
        return 'loopback'
    if ip.version == 4 and any(ip in net for net in RFC1918):
        return 'RFC1918'
    if ip.version == 6 and ip in ipaddress.ip_network('fc00::/7'):
        return 'IPv6 local'
    if ip.version == 6 and ip.is_link_local:
        return 'IPv6 link-local'
    if ip.is_multicast or not ip.is_global:
        return 'other special-use'
    return 'external'


def choose_backend():
    try:
        module = importlib.import_module('pyshark')
        if shutil.which('tshark'):
            return 'pyshark', module
    except ImportError:
        pass
    try:
        return 'scapy', importlib.import_module('scapy.all')
    except ImportError as exc:
        raise RuntimeError('Install pyshark plus the TShark executable, or scapy. '
                           'Run: pip install pyshark scapy') from exc


def packets(path, backend, module):
    if backend == 'pyshark':
        capture = module.FileCapture(str(path), keep_packets=False)
        try:
            for p in capture:
                layer = getattr(p, 'ip', None) or getattr(p, 'ipv6', None)
                yield (layer.src, layer.dst, int(p.length)) if layer else None
        finally:
            capture.close()
    else:
        with module.PcapReader(str(path)) as capture:
            for p in capture:
                layer = p.getlayer(module.IP) or p.getlayer(module.IPv6)
                yield (layer.src, layer.dst, int(getattr(p, 'wirelen', None) or len(p))) if layer else None


def inventory(records, source_ips):
    sources = {ipaddress.ip_address(s) for s in source_ips}
    hosts = defaultdict(lambda: {'packets':0, 'bytes':0})
    skipped = {'non_ip':0, 'not_from_source':0}
    for row in records:
        if row is None:
            skipped['non_ip'] += 1; continue
        src, dst, size = row
        src, dst = ipaddress.ip_address(src), ipaddress.ip_address(dst)
        if sources and src not in sources:
            skipped['not_from_source'] += 1; continue
        if size < 0:
            raise ValueError('negative packet length')
        target = hosts[str(dst)]
        target['packets'] += 1
        target['bytes'] += size
    return dict(hosts), skipped


def print_inventory(hosts, skipped, source_ips, backend):
    print(f'Parser: {backend}; packet bytes (including headers), grouped by destination IP; no DNS lookups')
    print('Scope: mirror-originated packets' if source_ips else 'Scope: all packet destinations (direction unspecified)')
    print(f"{'destination IP':<40} {'classification':<20} {'packets':>10} {'bytes':>14}")
    for host, counts in sorted(hosts.items(), key=lambda kv: (-kv[1]['bytes'], kv[0])):
        print(f"{host:<40} {destination_kind(host):<20} {counts['packets']:>10} {counts['bytes']:>14}")
    print(f'Skipped: {skipped}')
    if source_ips:
        count = sum(destination_kind(h) == 'external' and c['bytes'] > THRESHOLD for h,c in hosts.items())
        print(f'VOLUME OBSERVATION: {count} external destination IPs received > 1,000,000 bytes from the supplied source IPs')
    else:
        print('No egress verdict: supply --source-ip for every mirror capture-interface address.')
    print('This does not identify encrypted payloads, prove descriptor absence, or establish absence of video streaming.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pcap', type=Path)
    parser.add_argument('--source-ip', action='append', default=[], type=ipaddress.ip_address)
    args = parser.parse_args(argv)
    if not args.pcap.is_file():
        parser.error(f'capture not found: {args.pcap}')
    try:
        backend, module = choose_backend()
        hosts, skipped = inventory(packets(args.pcap, backend, module), args.source_ip)
        print_inventory(hosts, skipped, args.source_ip, backend)
    except (RuntimeError, OSError, ValueError) as exc:
        parser.exit(1, f'Capture analysis failed: {exc}\n')


if __name__ == '__main__':
    main()
