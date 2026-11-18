"""Exercise map serialization without importing or contacting a real device."""

import importlib.util
from pathlib import Path
import struct
import sys
import types
import unittest
from unittest.mock import patch


def load_worker():
    cli = types.ModuleType("roborock.cli")
    cli.RoborockContext = object
    with patch.dict(sys.modules, {"roborock": types.ModuleType("roborock"), "roborock.cli": cli}):
        spec = importlib.util.spec_from_file_location("robot_worker_test_module", Path(__file__).with_name("robot-worker.py"))
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
    return worker


class MapMetadataTests(unittest.IsolatedAsyncioTestCase):
    async def serialized_map(self, room_marker):
        worker = load_worker()
        data = types.SimpleNamespace(calibration=lambda: [], vacuum_position=None, charger=None)
        if room_marker != "missing":
            data.vacuum_room = room_marker
        trait = types.SimpleNamespace(
            image_content=b"\x89PNG\r\n\x1a\n" + b"\0" * 8 + struct.pack(">II", 100, 100),
            map_data=data,
        )
        adapter = worker.RobotAdapter.__new__(worker.RobotAdapter)

        async def refreshed(name):
            self.assertEqual(name, "map_content")
            return trait

        adapter.refreshed = refreshed
        return await adapter.map()

    async def test_returns_the_actual_parsed_room_segment(self):
        result = await self.serialized_map(2)
        self.assertEqual(result["currentRoomId"], 2)
        self.assertEqual(result["currentRoomSource"], "map.vacuum_room")
        self.assertIsNone(result["robotPosition"])

    async def test_unavailable_or_invalid_segments_stay_unknown(self):
        for value in ("missing", None, -1, 0, 2.5, "2", True):
            with self.subTest(value=value):
                result = await self.serialized_map(value)
                self.assertIsNone(result["currentRoomId"])
                self.assertIsNone(result["currentRoomSource"])


if __name__ == "__main__":
    unittest.main()
