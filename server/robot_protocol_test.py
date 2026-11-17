import unittest

from robot_protocol import validate_acknowledgement


class AcknowledgementTests(unittest.TestCase):
    def test_rejects_firmware_errors_inside_successful_rpc_transport(self):
        for response in (["unknown_method"], ["error"], {"result": ["invalid_params"]}, {"error": {"code": -1}}, {"code": -10005}, False):
            with self.subTest(response=response):
                with self.assertRaises(ValueError):
                    validate_acknowledgement(response)

    def test_retains_valid_acknowledgements_and_empty_protocol_responses(self):
        for response in (["ok"], "ok", {"code": 0, "result": ["ok"]}, None):
            with self.subTest(response=response):
                self.assertEqual(validate_acknowledgement(response), response)


if __name__ == "__main__":
    unittest.main()
