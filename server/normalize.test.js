'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRobot, normalizeRooms } = require('./normalize');

test('the real Saros camelCase telemetry updates time, area, custom power and tank warning', () => {
  const robot = normalizeRobot({ state: 8, battery: 100, cleanTime: 1021, cleanArea: 8245000, fanPower: 106, errorCode: 0, dockErrorStatus: 38, inCleaning: 0 }, null, 1234);
  assert.equal(robot.cleanTimeSeconds, 1021);
  assert.equal(robot.cleanAreaM2, 8.245);
  assert.equal(robot.fanLabel, 'Personalizado');
  assert.equal(robot.updatedAt, 1234);
  assert.equal(robot.alerts[0].id, 'clean-water-empty');
  assert.equal(robot.label, 'Na base · carregado');
});

test('water warning survives omitted data and another error, then clears on confirmed dock OK', () => {
  const warning = normalizeRobot({ state: 8, dockErrorStatus: 38 });
  const missing = normalizeRobot({ state: 8 }, warning);
  assert.equal(missing.alerts[0].id, 'clean-water-empty');
  const unknown = normalizeRobot({ state: 8, dockErrorStatus: 999 }, missing);
  assert.equal(unknown.alerts.length, 2);
  assert.equal(unknown.alerts[1].id, 'dock-error-999');
  const resolved = normalizeRobot({ state: 8, dockErrorStatus: 0 }, unknown);
  assert.deepEqual(resolved.alerts, []);
});

test('unknown states and errors remain explicit instead of becoming OK', () => {
  const robot = normalizeRobot({ state: 471, error_code: 888, dock_error_status: 999, clean_time: 20, fan_power: 104 });
  assert.equal(robot.state, 'unknown');
  assert.equal(robot.label, 'Estado 471');
  assert.equal(robot.errorCode, 888);
  assert.equal(robot.cleanTimeSeconds, 20);
  assert.equal(robot.alerts.length, 2);
  assert.throws(() => normalizeRobot({ error: 'Sem resposta' }));
});

test('real room IDs get their names from map metadata instead of undefined rawName', () => {
  const rooms = normalizeRooms({ rooms: [{ segmentId: 2, iotId: 'ignored' }, { segmentId: 3 }] }, { mapInfo: [{ rooms: [{ id: 2, iotName: 'Sala de estar' }, { id: 3, iotName: 'Cozinha' }] }] });
  assert.deepEqual(rooms, [{ id: 2, name: 'Sala de estar' }, { id: 3, name: 'Cozinha' }]);
});

test('installed-version states distinguish idle, charger loss, manual control and Saros mop operations', () => {
  const examples = [
    [2, 'charger_disconnected'], [3, 'idle'], [4, 'remote_control'],
    [25, 'washing_mops'], [33, 'attaching_mops'], [34, 'detaching_mops'],
    [202, 'stopping_drying'], [6305, 'room_clean_then_mop_vacuuming'],
    [6306, 'room_clean_then_mop_mopping'], [6310, 'returning_to_wash']
  ];
  for (const [code, state] of examples) assert.equal(normalizeRobot({ state: code }).state, state);
  assert.equal(normalizeRobot({ state: 101 }).online, false);
});

test('actual cleaning_info reports current room separately from its target', () => {
  const rooms = [{ id: 2, name: 'Sala de estar' }, { id: 3, name: 'Cozinha' }];
  const robot = normalizeRobot({ state: 6305, cleaning_info: { segment_id: 2, target_segment_id: 3 } }, null, 2000, rooms);
  assert.deepEqual(robot.location, { kind: 'room', label: 'Sala de estar', roomId: 2, updatedAt: 2000, source: 'status.cleaning_info.segment_id', stale: false });
  assert.equal(robot.targetRoomName, 'Cozinha');
  assert.equal(robot.phase, 'vacuuming');
});

test('the real dock sentinel is not a room and a destination alone never invents current location', () => {
  const rooms = [{ id: 2, name: 'Sala de estar' }];
  const docked = normalizeRobot({ state: 8, cleaning_info: { segment_id: -1, target_segment_id: -1 } }, null, 2000, rooms);
  assert.equal(docked.location.kind, 'dock');
  assert.equal(docked.location.roomId, null);
  assert.equal(docked.targetRoomName, undefined);
  for (const state of [6, 10, 15, 16, 18]) {
    const away = normalizeRobot({ state, cleaning_info: { segment_id: -1, target_segment_id: 2 } }, null, 2000, rooms);
    assert.equal(away.location.kind, 'unknown');
    assert.equal(away.location.label, 'Localização por confirmar');
    assert.equal(away.targetRoomName, 'Sala de estar');
  }
});

test('unmapped rooms remain explicit and fresh status never reuses an old room', () => {
  const first = normalizeRobot({ state: 18, cleaning_info: { segment_id: 2 } }, null, 1000, [{ id: 2, name: 'Sala' }]);
  const unknown = normalizeRobot({ state: 18, cleaning_info: { segment_id: 44 } }, first, 2000, [{ id: 2, name: 'Sala' }]);
  assert.equal(unknown.location.kind, 'unknown');
  assert.equal(unknown.location.roomId, 44);
  assert.equal(unknown.location.label, 'Divisão atual por identificar');
  const omitted = normalizeRobot({ state: 18 }, first, 3000, [{ id: 2, name: 'Sala' }]);
  assert.equal(omitted.location.kind, 'unknown');
  assert.equal(omitted.location.roomId, null);
});

test('offline status retains only the last confirmed location and its timestamp as stale', () => {
  const first = normalizeRobot({ state: 18, cleaning_info: { segment_id: 2 } }, null, 1000, [{ id: 2, name: 'Sala' }]);
  const offline = normalizeRobot({ state: 101, cleaning_info: { segment_id: 3 } }, first, 2000, [{ id: 3, name: 'Cozinha' }]);
  assert.equal(offline.online, false);
  assert.deepEqual(offline.location, { ...first.location, stale: true });
  assert.equal(offline.location.updatedAt, 1000);
});

test('verified robot and dock codes provide specific actions while unknown codes remain visible', () => {
  const robot = normalizeRobot({ state: 12, error_code: 5, dock_error_status: 39 });
  assert.equal(robot.alerts[0].title, 'Escova principal bloqueada');
  assert.match(robot.alerts[0].detail, /escova principal/);
  assert.equal(robot.alerts[0].code, 5);
  assert.equal(robot.alerts[0].source, 'robot');
  assert.equal(robot.alerts[1].title, 'Esvaziar depósito de água suja');
  assert.match(robot.alerts[1].detail, /Esvazia/);
  const unknown = normalizeRobot({ state: 12, error_code: 888 });
  assert.match(unknown.alerts[0].title, /888/);
  assert.match(unknown.alerts[0].detail, /não identificado/);
  const unreported = normalizeRobot({ state: 12, error_code: 0 });
  assert.equal(unreported.alerts[0].id, 'robot-error-unreported');
  assert.match(unreported.alerts[0].detail, /sem indicar o código/);
});
