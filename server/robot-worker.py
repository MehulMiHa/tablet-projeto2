"""Persistent JSON-lines adapter for the tablet's installed python-roborock.

Authentication is loaded from the existing Termux home, through RoborockContext.
Stdout contains protocol responses only. Library diagnostics go to stderr.
"""

import asyncio
import base64
import json
import logging
import os
import struct
import sys

from roborock.cli import RoborockContext
from robot_protocol import validate_acknowledgement


logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

ALLOWED_COMMANDS = {
    "set_custom_clean_mode", "set_customize_clean_mode", "set_mop_mode",
    "set_water_box_custom_mode", "set_custom_mode", "set_custom_water_level",
    "app_segment_clean", "app_zoned_clean", "app_pause", "app_start", "app_charge",
}


class RobotAdapter:
    def __init__(self):
        self.context = RoborockContext()
        self.device_id = os.environ["EDDY_DEVICE_ID"]
        self.properties = None

    async def connect(self):
        if self.properties is None:
            manager = await self.context.get_device_manager()
            device = await manager.get_device(self.device_id)
            if device.v1_properties is None:
                raise ValueError("O protocolo deste aspirador não é compatível.")
            self.properties = device.v1_properties
            await self.properties.start()
        return self.properties

    async def refreshed(self, name):
        properties = await self.connect()
        trait = getattr(properties, name, None)
        if trait is None:
            raise ValueError(f"A função {name} não está disponível neste aspirador.")
        await trait.refresh()
        return trait

    async def status(self):
        properties = await self.connect()
        # Raw status preserves unknown numeric error codes which older enum
        # adapters can otherwise silently coerce to zero.
        result = await properties.command.send("get_status", [])
        if isinstance(result, list) and result and isinstance(result[0], dict):
            result = result[0]
        if not isinstance(result, dict) or "state" not in result:
            raise ValueError("O aspirador devolveu uma resposta de estado inválida.")
        return result

    async def rooms(self):
        rooms = await self.refreshed("rooms")
        maps = await self.refreshed("maps")
        return {"rooms": rooms.as_dict(), "maps": maps.as_dict()}

    async def map(self):
        trait = await self.refreshed("map_content")
        image = trait.image_content
        data = trait.map_data
        if not image or not data:
            raise ValueError("O mapa ainda não está disponível.")
        if image[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError("O formato da imagem do mapa é inválido.")
        width, height = struct.unpack(">II", image[16:24])
        # vacuum-map-parser-roborock 0.1.5 reads the segmented pixel directly
        # under vacuum_position; it does not choose the nearest room.
        current_room_id = getattr(data, "vacuum_room", None)
        if type(current_room_id) is not int or current_room_id <= 0:
            current_room_id = None
        return {
            "imageBase64": base64.b64encode(image).decode("ascii"),
            "width": width,
            "height": height,
            "calibration": data.calibration(),
            "robotPosition": data.vacuum_position.as_dict() if data.vacuum_position else None,
            "charger": data.charger.as_dict() if data.charger else None,
            "currentRoomId": current_room_id,
            "currentRoomSource": "map.vacuum_room" if current_room_id is not None else None,
        }

    async def command(self, request):
        name = request.get("command")
        if name not in ALLOWED_COMMANDS:
            raise ValueError("Comando não suportado.")
        properties = await self.connect()
        result = await properties.command.send(name, request.get("params", []))
        validate_acknowledgement(result)
        return {"accepted": True, "response": result}

    async def dispatch(self, request):
        method = request.get("method")
        if method == "status":
            return await self.status()
        if method == "rooms":
            return await self.rooms()
        if method == "map":
            return await self.map()
        if method == "command":
            return await self.command(request)
        raise ValueError("Pedido de diagnóstico desconhecido.")

    async def close(self):
        await self.context.cleanup()


async def main():
    adapter = RobotAdapter()
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            request = None
            try:
                if len(line) > 65536:
                    raise ValueError("Pedido demasiado grande.")
                request = json.loads(line)
                result = await asyncio.wait_for(adapter.dispatch(request), timeout=35)
                response = {"id": request.get("id"), "ok": True, "result": result}
            except Exception as error:
                logging.warning("Pedido %s falhou: %s", request.get("method") if isinstance(request, dict) else "inválido", type(error).__name__)
                message = "O Saros não respondeu a tempo." if isinstance(error, TimeoutError) else str(error)
                # Avoid disclosing authentication material in HTTP diagnostics.
                if len(message) > 240 or "token" in message.lower() or "password" in message.lower():
                    message = "Não foi possível comunicar com o Saros."
                response = {"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": message}
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    finally:
        await adapter.close()


if __name__ == "__main__":
    asyncio.run(main())
