import csv
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image
import evaluate_clip_heads as ev
import train_clip_heads as fashion
import train_clip_heads_dfmm_hf as dfmm


def examples():
    img = Image.new('RGB', (2, 2))
    return [dict(image=img, masterCategory='Apparel', subCategory='Topwear', articleType='Tshirts', usage='Casual', text='cotton short-sleeve round pure color') for _ in range(9)]


class EvaluationTests(unittest.TestCase):
    def test_tail_matches_legacy_with_filtered_rows(self):
        rows = examples()
        rows[1]['masterCategory'] = 'unknown'
        rows[1]['subCategory'] = 'unknown'
        for module in [fashion, dfmm]:
            with self.subTest(module=module.__name__), patch.object(module, 'load_dataset', return_value=rows) as load:
                full = module.collect(7)
                stats = {}
                tail = module.collect(7, keep_last=3, revision='frozen', stats=stats)
                self.assertEqual(tail, full[-3:])
                self.assertEqual(stats['usable_rows'], 7)
                self.assertEqual(load.call_args.kwargs['revision'], 'frozen')

    def test_absent_class_and_unknown_predictions(self):
        m, report, matrix, policy = ev.score_head([0, 0, 2], [0, 2, 0], ['cotton','silk','unknown'], True)
        self.assertEqual(m['n'], 2)
        self.assertEqual(m['accuracy'], .5)
        self.assertAlmostEqual(m['macro_f1'], 1/3)
        self.assertEqual(report['silk']['support'], 0)
        self.assertEqual(matrix.sum(), 2)
        self.assertEqual(policy['excluded'], 1)
        self.assertEqual(m['n_classes'], 3)

    def test_no_known_labels(self):
        m, report, matrix, _ = ev.score_head([1], [0], ['cotton','unknown'], True)
        self.assertIsNone(m['accuracy'])
        self.assertIsNone(m['macro_f1'])
        self.assertEqual(matrix.sum(), 0)
        json.dumps(m, allow_nan=False)

    def test_fashion_absent_classes_are_in_macro(self):
        m, _, _, _ = ev.score_head([0], [0], ['one', 'two', 'three'])
        self.assertEqual(m['accuracy'], 1)
        self.assertAlmostEqual(m['macro_f1'], 1/3)

    def test_fallbacks_follow_each_trainer(self):
        rows = [{'category':'missing'}]
        maps = {'category':['top','other']}
        y, policy = ev.encode_labels(rows, maps, 'fashion')
        self.assertEqual(y['category'].tolist(), [1])
        self.assertEqual(policy['category']['fallback_count'], 1)
        y, policy = ev.encode_labels(rows, maps, 'dfmm')
        self.assertEqual(y['category'].tolist(), [0])

    def test_outputs_include_every_class(self):
        names = ['one', 'absent']
        m, report, matrix, _ = ev.score_head([0], [0], names)
        with tempfile.TemporaryDirectory() as d:
            ev.save_head(Path(d), 'category', names, report, matrix)
            with open(Path(d)/'per_class_category.csv', encoding='utf-8') as f:
                rows=list(csv.DictReader(f))
            self.assertEqual([r['class'] for r in rows], names)
            self.assertEqual(rows[1]['support'], '0')
            self.assertGreater((Path(d)/'confusion_category.png').stat().st_size, 100)
            self.assertEqual(ev.plt.get_fignums(), [])

    def test_local_split_and_empty_boundary(self):
        args = ev.arguments(['--headset','dfmm-local','--source','fixture','--model','model','--eval','200'])
        with patch('train_clip_heads_dfmm.build_rows', return_value=list(range(11))):
            rows, info = ev.select_rows(args)
            self.assertEqual(rows, [9,10])
        with patch('train_clip_heads_dfmm.build_rows', return_value=[1,2,3,4]):
            with self.assertRaisesRegex(ValueError, 'five'):
                ev.select_rows(args)

    def test_short_hf_collection_refused(self):
        args = ev.arguments(['--headset','fashion','--model','model','--train','10','--eval','2'])
        with patch('huggingface_hub.HfApi') as api, patch.object(fashion, 'load_dataset', return_value=examples()):
            api.return_value.dataset_info.return_value.sha='revision'
            with self.assertRaisesRegex(ValueError, 'shifted slice'):
                ev.select_rows(args)

    def test_fingerprint_changes_with_order_and_pixels(self):
        rows = [{'image':Image.new('RGB',(2,2),'red'),'label':'a'}, {'image':Image.new('RGB',(2,2),'blue'),'label':'b'}]
        self.assertNotEqual(ev.fingerprint(rows), ev.fingerprint(rows[::-1]))
        self.assertEqual(ev.fingerprint(rows), ev.fingerprint(rows))

if __name__ == '__main__':
    unittest.main()
