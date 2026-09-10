import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

import audit


class AuditTests(unittest.TestCase):
    def test_classifications(self):
        cases = {'10.1.2.3':'RFC1918','172.16.0.1':'RFC1918','192.168.0.1':'RFC1918',
                 '127.0.0.1':'loopback','::1':'loopback','fd00::1':'IPv6 local',
                 'fe80::1':'IPv6 link-local','8.8.8.8':'external','2606:4700:4700::1111':'external',
                 '192.0.2.1':'other special-use','224.0.0.1':'other special-use','100.64.0.1':'other special-use'}
        for value, expected in cases.items():
            self.assertEqual(audit.destination_kind(value),expected)

    def test_real_pcap_direction_and_bytes(self):
        from scapy.all import Ether, IP, IPv6, UDP, Raw, wrpcap
        frames = [Ether()/IP(src='192.168.1.2',dst='8.8.8.8')/UDP()/Raw(b'abc'),
                  Ether()/IP(src='8.8.8.8',dst='192.168.1.2')/UDP()/Raw(b'response'),
                  Ether()/IPv6(src='fd00::2',dst='2606:4700:4700::1111')/UDP()/Raw(b'data')]
        import scapy.all as scapy
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'fixture.pcap'
            wrpcap(str(path), frames)
            hosts, skipped = audit.inventory(audit.packets(path,'scapy',scapy), ['192.168.1.2','fd00::2'])
        self.assertEqual(hosts['8.8.8.8'], {'packets':1,'bytes':len(frames[0])})
        self.assertEqual(hosts['2606:4700:4700::1111']['bytes'],len(frames[2]))
        self.assertEqual(skipped['not_from_source'],1)

    def test_threshold_is_strict_and_inventory_has_no_verdict(self):
        hosts={'8.8.8.8':{'packets':1,'bytes':1000000},'1.1.1.1':{'packets':1,'bytes':1000001}}
        with contextlib.redirect_stdout(io.StringIO()) as out:
            audit.print_inventory(hosts,{},['192.168.1.2'],'fixture')
        self.assertIn('1 external destination',out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as out:
            audit.print_inventory(hosts,{},[],'fixture')
        self.assertNotIn('VOLUME OBSERVATION:',out.getvalue())

    def test_parser_fallback_and_install_message(self):
        with patch.object(audit.importlib,'import_module',return_value=MagicMock()), patch.object(audit.shutil,'which',return_value=None):
            self.assertEqual(audit.choose_backend()[0],'scapy')
        with patch.object(audit.importlib,'import_module',side_effect=ImportError), self.assertRaisesRegex(RuntimeError,'pip install pyshark scapy'):
            audit.choose_backend()
        with patch.object(audit.importlib,'import_module',return_value=MagicMock()), patch.object(audit.shutil,'which',return_value='/usr/bin/tshark'):
            self.assertEqual(audit.choose_backend()[0],'pyshark')

    def test_non_ip_and_empty_capture(self):
        hosts, skipped=audit.inventory([None],[])
        self.assertEqual(hosts,{})
        self.assertEqual(skipped['non_ip'],1)

if __name__ == '__main__':
    unittest.main()
