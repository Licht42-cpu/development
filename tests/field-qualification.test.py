"""Qualification-record checks; these never assert device behavior."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('qualification', Path(__file__).parents[1] / 'scripts/field-qualification.py')
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


class QualificationRecordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.record = {'schema_version': 1, 'candidate': {'sha': q.REQUIRED_CODEX,
                        'classification': 'isolated_codex_preparation', 'tracked_changes': '', 'authorization_reference': None},
                       'apk': {'sha256': None}, 'target': {},
                       'cases': [{'id': key, 'status': 'UNRUN', 'reason': 'No device', 'evidence': []} for key in q.CASES]}

    def tearDown(self):
        self.temp.cleanup()

    def test_preparation_record_is_valid_but_cannot_pass_device_gate(self):
        self.assertEqual(q.record_errors(self.record, self.directory), [])
        self.assertGreater(len(q.device_errors(self.record)), 0)

    def test_browser_or_emulator_cannot_replace_a_physical_device(self):
        for kind in ['browser', 'emulator']:
            self.record['target']['kind'] = kind
            self.assertTrue(any('physical Android' in e for e in q.device_errors(self.record)))

    def test_isolated_git_candidate_cannot_claim_integration(self):
        self.assertTrue(any('both required tracks' in e for e in q.device_errors(self.record)))

    def test_missing_or_duplicate_case_cannot_vanish_from_results(self):
        self.record['cases'].pop()
        self.assertTrue(q.record_errors(self.record, self.directory))
        self.record['cases'].append(copy.deepcopy(self.record['cases'][0]))
        self.assertTrue(any('duplicated' in e for e in q.record_errors(self.record, self.directory)))

    def test_a_pass_needs_steps_observation_and_evidence(self):
        self.record['cases'][0]['status'] = 'PASS'
        self.assertTrue(any('actual steps' in e for e in q.record_errors(self.record, self.directory)))

    def test_existing_unchanged_evidence_is_accepted_as_a_reference(self):
        path = self.directory / 'operator-observation.txt'
        path.write_text('Synthetic validator fixture, not an Android observation.')
        self.record['cases'][0]['evidence'] = [{'file': path.name, 'sha256': q.digest(path)}]
        self.assertEqual(q.record_errors(self.record, self.directory), [])

    def test_changed_evidence_is_refused(self):
        path = self.directory / 'observation.txt'
        path.write_text('before')
        self.record['cases'][0]['evidence'] = [{'file': path.name, 'sha256': q.digest(path)}]
        path.write_text('after')
        self.assertTrue(any('hash mismatched' in e for e in q.record_errors(self.record, self.directory)))

    def test_parent_path_cannot_reference_other_customer_files(self):
        self.record['cases'][0]['evidence'] = [{'file': '../private.txt', 'sha256': '0' * 64}]
        self.assertTrue(any('inside' in e for e in q.record_errors(self.record, self.directory)))

    def test_absolute_path_cannot_be_an_evidence_reference(self):
        self.record['cases'][0]['evidence'] = [{'file': '/etc/passwd', 'sha256': '0' * 64}]
        self.assertTrue(any('inside' in e for e in q.record_errors(self.record, self.directory)))

    def test_unrun_skip_and_expected_failure_each_need_a_reason(self):
        for status in ['UNRUN', 'SKIPPED', 'EXPECTED_FAILURE']:
            self.record['cases'][0].update(status=status, reason=None)
            self.assertTrue(any('explicit reason' in e for e in q.record_errors(self.record, self.directory)))

    def test_future_format_fails_closed(self):
        self.record['schema_version'] = 2
        self.assertTrue(q.record_errors(self.record, self.directory))

    def test_device_timestamp_must_have_timezone_and_not_be_future(self):
        for value in ['2026-01-01', '2999-01-01T00:00:00+00:00']:
            self.record['target']['tested_at'] = value
            self.assertTrue(any('timestamp' in e for e in q.device_errors(self.record)))

    def test_an_existing_unbound_apk_cannot_qualify_the_candidate(self):
        self.record['apk']['sha256'] = 'a' * 64
        self.assertTrue(any('match the recorded candidate' in e for e in q.device_errors(self.record)))

    def test_wrong_metadata_types_fail_with_a_supported_diagnostic(self):
        self.record['candidate'] = []
        self.assertTrue(q.record_errors(self.record, self.directory))


if __name__ == '__main__':
    unittest.main(verbosity=2)
