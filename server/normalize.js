'use strict';

const { errorAlert } = require('./robot-errors');

const STATES = {
  0: ['unknown', 'Estado desconhecido', 'unknown'],
  1: ['starting', 'A iniciar', 'unknown'],
  2: ['charger_disconnected', 'Carregador desligado', 'idle'],
  3: ['idle', 'Em espera', 'idle'],
  4: ['remote_control', 'Controlo manual', 'unknown'],
  5: ['cleaning', 'A limpar', 'vacuuming'],
  6: ['returning', 'A regressar à base', 'returning'],
  7: ['manual', 'Controlo manual', 'unknown'],
  8: ['charging', 'Na base', 'idle'],
  9: ['charging_error', 'Verificar carregamento', 'error'],
  10: ['paused', 'Limpeza em pausa', 'paused'],
  11: ['spot_cleaning', 'A limpar uma zona', 'vacuuming'],
  12: ['error', 'O Rocky precisa de ajuda', 'error'],
  13: ['shutting_down', 'A desligar', 'unknown'],
  14: ['updating', 'A atualizar', 'unknown'],
  15: ['docking', 'A entrar na base', 'returning'],
  16: ['going_to_target', 'A deslocar-se', 'unknown'],
  17: ['zone_cleaning', 'A limpar uma zona', 'vacuuming'],
  18: ['room_cleaning', 'A limpar divisões', 'vacuuming'],
  22: ['emptying_dust', 'A esvaziar o depósito', 'emptying_dust'],
  23: ['washing_mops', 'A lavar as mopas', 'washing_mops'],
  25: ['washing_mops', 'A lavar as mopas', 'washing_mops'],
  26: ['going_to_wash', 'A regressar para lavar as mopas', 'returning'],
  28: ['in_call', 'Chamada em curso', 'unknown'],
  29: ['mapping', 'A criar o mapa', 'mapping'],
  30: ['special_activity', 'Atividade do Rocky (30)', 'unknown'],
  32: ['patrol', 'Em ronda', 'patrol'],
  33: ['attaching_mops', 'A colocar as mopas', 'attaching_mops'],
  34: ['detaching_mops', 'A retirar as mopas', 'detaching_mops'],
  100: ['charged', 'Na base · carregado', 'idle'],
  101: ['offline', 'Rocky sem ligação', 'unknown'],
  103: ['locked', 'Rocky bloqueado', 'locked'],
  202: ['stopping_drying', 'A terminar a secagem', 'drying_mops'],
  6301: ['mopping', 'A lavar o chão', 'mopping'],
  6302: ['clean_then_mop_vacuuming', 'A aspirar', 'vacuuming'],
  6303: ['clean_then_mop_mopping', 'A lavar o chão', 'mopping'],
  6304: ['room_mopping', 'A lavar divisões', 'mopping'],
  6305: ['room_clean_then_mop_vacuuming', 'A aspirar divisões', 'vacuuming'],
  6306: ['room_clean_then_mop_mopping', 'A lavar divisões', 'mopping'],
  6307: ['zone_mopping', 'A lavar uma zona', 'mopping'],
  6308: ['zone_clean_then_mop_vacuuming', 'A aspirar uma zona', 'vacuuming'],
  6309: ['zone_clean_then_mop_mopping', 'A lavar uma zona', 'mopping'],
  6310: ['returning_to_wash', 'A regressar para lavar as mopas', 'returning']
};

const FAN_LABELS = {
  101: 'Silencioso', 102: 'Normal', 103: 'Turbo', 104: 'Máximo',
  105: 'Desligado', 106: 'Personalizado', 108: 'Máximo+', 110: 'Inteligente'
};

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function field(raw, camel, snake) {
  return raw[camel] === undefined ? raw[snake] : raw[camel];
}

function roomId(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function unknownLocation(updatedAt = null) {
  return { kind: 'unknown', label: 'Localização por confirmar', roomId: null, updatedAt, source: 'unavailable', stale: true };
}

function resolveRobotLocation(robot, rooms = []) {
  if (!robot.online) return { ...(robot.location || unknownLocation()), stale: true };
  const currentRoomId = roomId(robot.currentRoomId);
  const currentRoom = rooms.find(room => room.id === currentRoomId);
  // A target segment describes the destination, never the current room.
  if (currentRoomId !== null) {
    return {
      kind: currentRoom ? 'room' : 'unknown',
      label: currentRoom ? currentRoom.name : 'Divisão atual por identificar',
      roomId: currentRoomId, updatedAt: robot.updatedAt,
      source: 'status.cleaning_info.segment_id', stale: false
    };
  }
  // Returning/docking states are deliberately absent: they do not confirm arrival.
  if ([8, 22, 23, 25, 100, 202].includes(robot.stateCode)) {
    return { kind: 'dock', label: 'Na base', roomId: null, updatedAt: robot.updatedAt, source: 'status.state', stale: false };
  }
  return { ...unknownLocation(robot.updatedAt), stale: false };
}

function withRobotLocation(robot, rooms = []) {
  const target = rooms.find(room => room.id === robot.targetRoomId);
  const result = { ...robot, location: resolveRobotLocation(robot, rooms) };
  if (target) result.targetRoomName = target.name;
  else delete result.targetRoomName;
  return result;
}

function normalizeRobot(raw, previous = null, now = Date.now(), rooms = []) {
  if (!raw || typeof raw !== 'object' || numeric(raw.state) === null) {
    throw new Error('O Saros devolveu um estado inválido.');
  }
  const stateCode = raw.state;
  const descriptor = STATES[stateCode] || ['unknown', `Estado ${stateCode}`, 'unknown'];
  const battery = numeric(raw.battery);
  const cleanTime = numeric(field(raw, 'cleanTime', 'clean_time'));
  const cleanArea = numeric(field(raw, 'cleanArea', 'clean_area'));
  const fanPower = numeric(field(raw, 'fanPower', 'fan_power'));
  const errorCode = numeric(field(raw, 'errorCode', 'error_code'));
  const dockErrorCode = numeric(field(raw, 'dockErrorStatus', 'dock_error_status'));
  const waterBoxMode = numeric(field(raw, 'waterBoxMode', 'water_box_mode'));
  const cleaningInfo = field(raw, 'cleaningInfo', 'cleaning_info') || {};
  const alerts = [];
  const previousWaterAlert = previous && previous.alerts && previous.alerts.find(alert => alert.id === 'clean-water-empty');

  if (dockErrorCode === 38 || (previousWaterAlert && dockErrorCode !== 0)) {
    alerts.push(errorAlert(38, 'dock'));
  }
  if (errorCode !== null && errorCode !== 0) {
    alerts.push(errorAlert(errorCode, 'robot'));
  }
  if (dockErrorCode !== null && dockErrorCode !== 0 && dockErrorCode !== 38) {
    alerts.push(errorAlert(dockErrorCode, 'dock'));
  }
  if ((errorCode === null || errorCode === 0) && [9, 12].includes(stateCode)) {
    alerts.push({
      id: 'robot-error-unreported', severity: 'error', source: 'robot', code: null,
      title: stateCode === 9 ? 'Verificar carregamento' : 'O Rocky precisa de ajuda',
      detail: stateCode === 9 ? 'Verifica os contactos de carga e a alimentação da base. O Rocky não indicou um código de erro.' : 'O Rocky reportou um erro sem indicar o código. Consulta o aviso na app Roborock.'
    });
  }

  let phase = descriptor[2];
  let label = descriptor[1];
  if ([5, 11, 17, 18].includes(stateCode) && (fanPower === 105 || waterBoxMode === 200)) {
    phase = fanPower === 105 ? 'mopping' : 'vacuuming';
    label = fanPower === 105 ? 'A lavar o chão' : 'A aspirar';
  }
  if ([5, 11, 17, 18].includes(stateCode) && fanPower !== null && fanPower !== 105 && waterBoxMode !== null && waterBoxMode > 200) {
    phase = 'vacuum_mop';
    label = 'A aspirar e lavar';
  }
  if (stateCode === 8 && battery === 100) label = 'Na base · carregado';
  if ([8, 100].includes(stateCode) && field(raw, 'dryStatus', 'dry_status') === 1) {
    phase = 'drying_mops';
    label = 'A secar as mopas';
  }

  return withRobotLocation({
    online: stateCode !== 101, stateCode, state: descriptor[0], label, phase,
    battery, cleanTimeSeconds: cleanTime,
    cleanAreaM2: cleanArea === null ? null : cleanArea / 1000000,
    fanPower, fanLabel: FAN_LABELS[fanPower] || (fanPower === null ? null : `Modo ${fanPower}`),
    errorCode, dockErrorCode, waterBoxMode,
    inCleaning: numeric(field(raw, 'inCleaning', 'in_cleaning')),
    inReturning: numeric(field(raw, 'inReturning', 'in_returning')),
    washStatus: numeric(field(raw, 'washStatus', 'wash_status')),
    dryStatus: numeric(field(raw, 'dryStatus', 'dry_status')),
    lastCleanTime: numeric(field(raw, 'lastCleanT', 'last_clean_t')),
    currentRoomId: roomId(field(cleaningInfo, 'segmentId', 'segment_id')),
    targetRoomId: roomId(field(cleaningInfo, 'targetSegmentId', 'target_segment_id')),
    location: previous ? previous.location : null,
    updatedAt: now, alerts, currentJob: previous ? previous.currentJob || null : null
  }, rooms);
}

function normalizeRooms(roomMapping, mapInfo) {
  const names = new Map();
  const cloudNames = new Map();
  const maps = mapInfo && (mapInfo.mapInfo || mapInfo.map_info) || [];
  for (const map of maps) {
    for (const room of map.rooms || []) {
      const name = room.iotName || room.iot_name || room.name;
      if (typeof name === 'string' && name.trim()) {
        const cleanName = name.trim();
        const id = Number(room.id);
        if (names.has(id) && names.get(id) !== cleanName) names.set(id, null);
        else if (!names.has(id)) names.set(id, cleanName);
        const cloudId = room.iotNameId || room.iot_name_id;
        if (cloudId) cloudNames.set(String(cloudId), cleanName);
      }
    }
  }
  const rooms = roomMapping && roomMapping.rooms;
  if (!Array.isArray(rooms)) throw new Error('Não foi possível ler as divisões do mapa.');
  return rooms.map(room => {
    const id = Number(room.segmentId === undefined ? room.segment_id : room.segmentId);
    if (!Number.isInteger(id) || id < 0) throw new Error('O mapa contém uma divisão inválida.');
    const suppliedName = room.rawName || room.name;
    const cloudId = room.iotId || room.iot_id;
    return { id, name: cloudNames.get(String(cloudId)) || names.get(id) || suppliedName || `Divisão ${id}` };
  });
}

function temperatureRgb(kelvin) {
  const temperature = Math.max(1000, Math.min(40000, kelvin)) / 100;
  const red = temperature <= 66 ? 255 : 329.698727446 * Math.pow(temperature - 60, -0.1332047592);
  const green = temperature <= 66 ? 99.4708025861 * Math.log(temperature) - 161.1195681661 : 288.1221695283 * Math.pow(temperature - 60, -0.0755148492);
  const blue = temperature >= 66 ? 255 : temperature <= 19 ? 0 : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
  return [red, green, blue].map(channel => Math.round(Math.max(0, Math.min(255, channel))));
}

function xyRgb(xy) {
  const [x, y] = xy;
  if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) return [255, 255, 255];
  const X = x / y;
  const Z = (1 - x - y) / y;
  let values = [1.656492 * X - 0.354851 - 0.255038 * Z, -0.707196 * X + 1.655397 + 0.036152 * Z, 0.051713 * X - 0.121364 + 1.01153 * Z];
  values = values.map(value => value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055);
  const scale = Math.max(1, ...values);
  return values.map(value => Math.round(Math.max(0, Math.min(1, value / scale)) * 255));
}

function hueLight(id, state) {
  const temperature = state.ct && (!state.colormode || state.colormode === 'ct') ? Math.round(1000000 / state.ct) : null;
  let rgb = temperatureRgb(temperature || 3000);
  if (state.colormode === 'xy' && Array.isArray(state.xy)) rgb = xyRgb(state.xy);
  if (state.colormode === 'hs' && Number.isFinite(state.hue) && Number.isFinite(state.sat)) {
    const hue = state.hue / 65535 * 6;
    const saturation = state.sat / 254;
    const chroma = saturation;
    const secondary = chroma * (1 - Math.abs(hue % 2 - 1));
    const offset = 1 - chroma;
    const sectors = [[chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary], [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary]];
    rgb = sectors[Math.min(5, Math.floor(hue))].map(value => Math.round((value + offset) * 255));
  }
  return {
    id, name: id === 'sanca' ? 'Fita LED' : `Foco ${id.split('-')[1]}`,
    on: !!state.on,
    brightness: typeof state.bri === 'number' ? Math.round(state.bri * 100 / 254) : null,
    temperature, rgb, colorMode: state.colormode || 'ct', reachable: state.reachable !== false
  };
}

module.exports = { normalizeRobot, normalizeRooms, withRobotLocation, unknownLocation, hueLight, temperatureRgb, xyRgb, numeric };
