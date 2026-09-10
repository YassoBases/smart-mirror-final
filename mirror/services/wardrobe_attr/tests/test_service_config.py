import importlib
import os
import unittest
from unittest.mock import patch


class ServiceConfig(unittest.TestCase):
    def test_configuration_precedence(self):
        # Compatibility aliases are intentionally exercised outside the archive.
        for env, model, token in [
            ({'BLIP2_MODEL_DIR':'old', 'BLIP2_ENDPOINT_TOKEN':'old'}, 'old', 'old'),
            ({'WARDROBE_ATTR_MODEL_DIR':'new', 'WARDROBE_ATTR_ENDPOINT_TOKEN':'new'}, 'new', 'new'),
            ({'BLIP2_MODEL_DIR':'old', 'BLIP2_ENDPOINT_TOKEN':'old',
              'WARDROBE_ATTR_MODEL_DIR':'new', 'WARDROBE_ATTR_ENDPOINT_TOKEN':'new'}, 'new', 'new'),
            ({'BLIP2_MODEL_DIR':'old', 'BLIP2_ENDPOINT_TOKEN':'old',
              'WARDROBE_ATTR_MODEL_DIR':'', 'WARDROBE_ATTR_ENDPOINT_TOKEN':''}, '', ''),
        ]:
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True):
                import serve_clip
                importlib.reload(serve_clip)
                self.assertEqual(serve_clip.MODEL_DIR, model)
                self.assertEqual(serve_clip.TOKEN, token)
                self.assertEqual(serve_clip.app.title, 'wardrobe_attr')

if __name__ == '__main__':
    unittest.main()
